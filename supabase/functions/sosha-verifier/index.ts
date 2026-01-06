// supabase/functions/sosha-verifier/index.ts
//
// Sosha Verifier - Supabase Edge Function
//
// Verifies Ethiopian payment receipts (CBE, Telebirr, Dashen, Abyssinia, CBE Birr)
// and records successful verifications into Postgres (verified_receipts).
//
// This function enforces a simple API key system using the `api_keys` table.
// Only requests with a valid `x-api-key` header are processed.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3";
import * as pdfjsLib from "https://esm.sh/pdfjs-dist@3.11.174?target=deno";

type JsonRecord = Record<string, unknown>;

// ---------- Supabase client ----------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars. " +
      "Sosha Verifier will not be able to access the database.",
  );
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// ---------- Types ----------

interface ApiKeyRecord {
  id: string;
  name: string;
}

interface SimpleVerifyResult {
  success: boolean;
  payer?: string;
  payerAccount?: string;
  receiver?: string;
  receiverAccount?: string;
  amount?: number;
  date?: string;
  reference?: string;
  reason?: string | null;
  error?: string;
}

interface TelebirrReceipt {
  payerName: string;
  payerTelebirrNo: string;
  creditedPartyName: string;
  creditedPartyAccountNo: string;
  transactionStatus: string;
  receiptNo: string;
  paymentDate: string;
  settledAmount: string;
  serviceFee: string;
  serviceFeeVAT: string;
  totalPaidAmount: string;
  bankName: string;
}

interface DashenVerifyResult {
  success: boolean;
  senderName?: string;
  senderAccountNumber?: string;
  transactionChannel?: string;
  serviceType?: string;
  narrative?: string;
  receiverName?: string;
  phoneNo?: string;
  institutionName?: string;
  transactionReference?: string;
  transferReference?: string;
  transactionDate?: string;
  transactionAmount?: number;
  serviceCharge?: number;
  exciseTax?: number;
  vat?: number;
  penaltyFee?: number;
  incomeTaxFee?: number;
  interestFee?: number;
  stampDuty?: number;
  discountAmount?: number;
  total?: number;
  error?: string;
}

interface CbeBirrReceipt {
  customerName: string;
  debitAccount: string;
  creditAccount: string;
  receiverName: string;
  orderId: string;
  transactionStatus: string;
  reference: string;
  receiptNumber: string;
  transactionDate: string;
  amount: string;
  paidAmount: string;
  serviceCharge: string;
  vat: string;
  totalPaidAmount: string;
  paymentReason: string;
  paymentChannel: string;
}

// ---------- HTTP helpers ----------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-api-key, x-cbe-birr-token, content-type",
};

function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

// Small helper to parse JSON body with proper error handling
async function parseJsonBody(req: Request): Promise<any | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// Utility: fetch with timeout using AbortController
async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// ---------- Supabase helpers ----------

async function requireSupabaseClient() {
  if (!supabase) {
    throw new Error("Supabase client not initialized");
  }
  return supabase;
}

async function getApiKeyRecord(apiKey: string): Promise<ApiKeyRecord | null> {
  const client = await requireSupabaseClient();

  const { data, error } = await client
    .from("api_keys")
    .select("id, name, is_active")
    .eq("key", apiKey)
    .maybeSingle();

  if (error) {
    console.error("Error querying api_keys:", error);
    throw error;
  }

  if (!data || data.is_active === false) {
    return null;
  }

  return { id: data.id as string, name: data.name as string };
}

async function ensureReceiptNotUsed(
  referenceNumber: string,
  bank: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = await requireSupabaseClient();

  const { data, error } = await client
    .from("verified_receipts")
    .select("id, verified_at")
    .eq("reference_number", referenceNumber)
    .eq("bank", bank)
    .maybeSingle();

  if (error) {
    console.error("Error querying verified_receipts:", error);
    throw error;
  }

  if (data) {
    const verifiedAt = data.verified_at as string;
    return {
      ok: false,
      message: `Receipt already used at Sosha on ${verifiedAt}.`,
    };
  }

  return { ok: true };
}

interface VerifiedReceiptInput {
  referenceNumber: string;
  bank: string;
  amount?: number | null;
  receiverAccount?: string | null;
  orderId?: string | null;
  branchId?: string | null;
  verifiedBy?: string | null;
  manualOverride?: boolean;
}

async function insertVerifiedReceipt(
  input: VerifiedReceiptInput,
): Promise<string> {
  const client = await requireSupabaseClient();

  const { data, error } = await client
    .from("verified_receipts")
    .insert({
      reference_number: input.referenceNumber,
      bank: input.bank,
      amount: input.amount ?? null,
      receiver_account: input.receiverAccount ?? null,
      order_id: input.orderId ?? null,
      branch_id: input.branchId ?? null,
      verified_by: input.verifiedBy ?? null,
      manual_override: input.manualOverride ?? false,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Error inserting into verified_receipts:", error);
    throw error;
  }

  return data.id as string;
}

// ---------- PDF helper ----------

async function extractPdfText(buffer: Uint8Array): Promise<string> {
  const loadingTask = (pdfjsLib as any).getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  let text = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = (content.items as any[])
      .map((item) => ("str" in item ? (item as any).str : ""))
      .join(" ");
    text += pageText + "\n";
  }

  return text.replace(/\s+/g, " ").trim();
}

function toTitleCase(str?: string): string | undefined {
  if (!str) return undefined;
  return str.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const numeric = parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

// ---------- CBE (Commercial Bank of Ethiopia) ----------

async function verifyCbeWithBank(
  reference: string,
  accountSuffix: string,
): Promise<SimpleVerifyResult> {
  const fullId = `${reference}${accountSuffix}`;
  const url = `https://apps.cbe.com.et:100/?id=${fullId}`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          Accept: "application/pdf",
        },
      },
      30000,
    );

    if (!res.ok) {
      console.error("CBE PDF fetch failed:", res.status);
      return {
        success: false,
        error: `Failed to fetch CBE receipt: HTTP ${res.status}`,
      };
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    return await parseCbeReceiptFromPdf(buffer);
  } catch (error) {
    console.error("Error fetching CBE PDF:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function parseCbeReceiptFromPdf(
  pdfBuffer: Uint8Array,
): Promise<SimpleVerifyResult> {
  try {
    const text = await extractPdfText(pdfBuffer);
    const rawText = text.replace(/\s+/g, " ").trim();

    let payerName = rawText.match(/Payer\s*:?\s*(.*?)\s+Account/i)?.[1]?.trim();
    let receiverName = rawText.match(
      /Receiver\s*:?\s*(.*?)\s+Account/i,
    )?.[1]?.trim();
    const accountMatches = [
      ...rawText.matchAll(
        /Account\s*:?\s*([A-Z0-9]?\*{4}\d{4})/gi,
      ),
    ];
    const payerAccount = accountMatches?.[0]?.[1];
    const receiverAccount = accountMatches?.[1]?.[1];

    const reason = rawText.match(
      /Reason\s*\/\s*Type of service\s*:?\s*(.*?)\s+Transferred Amount/i,
    )?.[1]?.trim();
    const amountText = rawText.match(
      /Transferred Amount\s*:?\s*([\d,]+\.\d{2})\s*ETB/i,
    )?.[1];
    const referenceMatch = rawText.match(
      /Reference No\.?\s*\(VAT Invoice No\)\s*:?\s*([A-Z0-9]+)/i,
    )?.[1]?.trim();
    const dateRaw = rawText.match(
      /Payment Date & Time\s*:?\s*([\d\/,: ]+[APM]{2})/i,
    )?.[1]?.trim();

    const amount = amountText
      ? parseFloat(amountText.replace(/,/g, ""))
      : undefined;
    const date = dateRaw ? new Date(dateRaw) : undefined;

    payerName = toTitleCase(payerName);
    receiverName = toTitleCase(receiverName);

    if (
      payerName && payerAccount && receiverName && receiverAccount &&
      amount != null && date && referenceMatch
    ) {
      return {
        success: true,
        payer: payerName,
        payerAccount,
        receiver: receiverName,
        receiverAccount,
        amount,
        date: date.toISOString(),
        reference: referenceMatch,
        reason: reason || null,
      };
    }

    return {
      success: false,
      error: "Could not extract all required fields from CBE PDF.",
    };
  } catch (error) {
    console.error("CBE PDF parsing failed:", error);
    return { success: false, error: "Error parsing CBE PDF data" };
  }
}

// ---------- Telebirr ----------

function extractSettledAmountRegex(htmlContent: string): string | null {
  const pattern1 =
    /የተከፈለው\s+መጠን\/Settled\s+Amount.*?<\/td>\s*<td[^>]*>\s*(\d+(?:\.\d{2})?\s+Birr)/is;
  let match = htmlContent.match(pattern1);
  if (match) return match[1].trim();

  const pattern2 =
    /<tr[^>]*>.*?የተከፈለው\s+መጠን\/Settled\s+Amount.*?<td[^>]*>\s*(\d+(?:\.\d{2})?\s+Birr)/is;
  match = htmlContent.match(pattern2);
  if (match) return match[1].trim();

  const pattern3 =
    /Settled\s+Amount.*?(\d+(?:\.\d{2})?\s+Birr)/is;
  match = htmlContent.match(pattern3);
  if (match) return match[1].trim();

  const pattern4 =
    /የክፍያ\s+ዝርዝር\/Transaction\s+details.*?<tr[^>]*>.*?<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*(\d+(?:\.\d{2})?\s+Birr)/is;
  match = htmlContent.match(pattern4);
  if (match) return match[1].trim();

  return null;
}

function extractServiceFeeRegex(htmlContent: string): string | null {
  const pattern =
    /የአገልግሎት\s+ክፍያ\/Service\s+fee(?!\s+ተ\.እ\.ታ).*?<\/td>\s*<td[^>]*>\s*(\d+(?:\.\d{2})?\s+Birr)/i;
  const match = htmlContent.match(pattern);
  if (match) return match[1].trim();
  return null;
}

function extractReceiptNoRegex(htmlContent: string): string | null {
  const pattern =
    /<td[^>]*class="[^"]*receipttableTd[^"]*receipttableTd2[^"]*"[^>]*>\s*([A-Z0-9]+)\s*<\/td>/i;
  const match = htmlContent.match(pattern);
  if (match) return match[1].trim();
  return null;
}

function extractDateRegex(htmlContent: string): string | null {
  const pattern = /(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/;
  const match = htmlContent.match(pattern);
  if (match) return match[1].trim();
  return null;
}

function extractWithRegex(
  htmlContent: string,
  labelPattern: string,
  valuePattern: string = "([^<]+)",
): string | null {
  const escapedLabel = labelPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `${escapedLabel}.*?<\\/td>\\s*<td[^>]*>\\s*${valuePattern}`,
    "i",
  );
  const match = htmlContent.match(pattern);
  if (!match) return null;
  return match[1].replace(/<[^>]*>/g, "").trim();
}

function extractWithRegexLegacy(htmlContent: string): {
  settledAmount: string | null;
  serviceFee: string | null;
} {
  const settledAmount = extractSettledAmountRegex(htmlContent);
  const serviceFee = extractServiceFeeRegex(htmlContent);
  return { settledAmount, serviceFee };
}

function getTextWithFallback(html: string, labelText: string): string {
  const viaRegex = extractWithRegex(html, labelText);
  if (viaRegex) return viaRegex;
  return "";
}

function parseTelebirrHtml(html: string): TelebirrReceipt | null {
  const regexResults = extractWithRegexLegacy(html);
  const settledAmount = regexResults.settledAmount ?? "";
  const serviceFee = regexResults.serviceFee ?? "";

  let creditedPartyName = getTextWithFallback(
    html,
    "የገንዘብ ተቀባይ ስም/Credited Party name",
  );
  let creditedPartyAccountNo = getTextWithFallback(
    html,
    "የገንዘብ ተቀባይ ቴሌብር ቁ./Credited party account no",
  );
  let bankName = "";

  const bankAccountNumberRaw = getTextWithFallback(
    html,
    "የባንክ አካውንት ቁጥር/Bank account number",
  );
  if (bankAccountNumberRaw) {
    bankName = creditedPartyName;
    const bankAccountRegex = /(\d+)\s+(.*)/;
    const match = bankAccountNumberRaw.match(bankAccountRegex);
    if (match) {
      creditedPartyAccountNo = match[1].trim();
      creditedPartyName = match[2].trim();
    }
  }

  const receiptNo = extractReceiptNoRegex(html) ?? "";
  const paymentDate = extractDateRegex(html) ?? "";

  const payerName = getTextWithFallback(
    html,
    "የከፋይ ስም/Payer Name",
  );
  const payerTelebirrNo = getTextWithFallback(
    html,
    "የከፋይ ቴሌብር ቁ./Payer telebirr no.",
  );
  const transactionStatus = getTextWithFallback(
    html,
    "የክፍያው ሁኔታ/transaction status",
  );
  const serviceFeeVAT = getTextWithFallback(
    html,
    "የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT",
  );
  const totalPaidAmount = getTextWithFallback(
    html,
    "ጠቅላላ የተከፈለ/Total Paid Amount",
  );

  if (!receiptNo && !payerName) {
    return null;
  }

  return {
    payerName,
    payerTelebirrNo,
    creditedPartyName,
    creditedPartyAccountNo,
    transactionStatus,
    receiptNo,
    paymentDate,
    settledAmount,
    serviceFee,
    serviceFeeVAT,
    totalPaidAmount,
    bankName,
  };
}

function parseTelebirrJson(jsonData: any): TelebirrReceipt | null {
  try {
    if (!jsonData || !jsonData.success || !jsonData.data) {
      return null;
    }

    const data = jsonData.data;
    return {
      payerName: data.payerName || "",
      payerTelebirrNo: data.payerTelebirrNo || "",
      creditedPartyName: data.creditedPartyName || "",
      creditedPartyAccountNo: data.creditedPartyAccountNo || "",
      transactionStatus: data.transactionStatus || "",
      receiptNo: data.receiptNo || "",
      paymentDate: data.paymentDate || "",
      settledAmount: data.settledAmount || "",
      serviceFee: data.serviceFee || "",
      serviceFeeVAT: data.serviceFeeVAT || "",
      totalPaidAmount: data.totalPaidAmount || "",
      bankName: data.bankName || "",
    };
  } catch (error) {
    console.error("Error parsing Telebirr JSON:", error);
    return null;
  }
}

function isTelebirrReceiptValid(receipt: TelebirrReceipt | null): boolean {
  if (!receipt) return false;
  return Boolean(
    receipt.receiptNo &&
      receipt.payerName &&
      receipt.transactionStatus,
  );
}

async function fetchTelebirrFromPrimary(
  reference: string,
): Promise<TelebirrReceipt | null> {
  const url = `https://transactioninfo.ethiotelecom.et/receipt/${reference}`;
  try {
    const res = await fetchWithTimeout(url, {}, 15000);
    if (!res.ok) {
      console.error(
        "Telebirr primary HTTP error:",
        res.status,
        res.statusText,
      );
      return null;
    }
    const html = await res.text();
    return parseTelebirrHtml(html);
  } catch (error) {
    console.error("Telebirr primary fetch error:", error);
    return null;
  }
}

async function fetchTelebirrFromProxy(
  reference: string,
): Promise<TelebirrReceipt | null> {
  const url = `https://leul.et/verify.php?reference=${reference}`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "application/json, text/html;q=0.9",
          "User-Agent": "SoshaVerifier/1.0",
        },
      },
      15000,
    );
    if (!res.ok) {
      console.error(
        "Telebirr proxy HTTP error:",
        res.status,
        res.statusText,
      );
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      const parsed = parseTelebirrJson(data);
      if (parsed) return parsed;
      // fall through to HTML if JSON parse fails
    }

    const text = await res.text();
    return parseTelebirrHtml(text);
  } catch (error) {
    console.error("Telebirr proxy fetch error:", error);
    return null;
  }
}

async function verifyTelebirrWithBank(
  reference: string,
): Promise<TelebirrReceipt | null> {
  const skipPrimary = Deno.env.get("SKIP_PRIMARY_VERIFICATION") === "true";

  if (!skipPrimary) {
    const primaryResult = await fetchTelebirrFromPrimary(reference);
    if (isTelebirrReceiptValid(primaryResult)) {
      return primaryResult;
    }
    console.warn(
      `Primary Telebirr verification failed for ${reference}, trying fallback proxy...`,
    );
  } else {
    console.log(
      "Skipping primary Telebirr receipt endpoint because SKIP_PRIMARY_VERIFICATION=true",
    );
  }

  const fallbackResult = await fetchTelebirrFromProxy(reference);
  if (isTelebirrReceiptValid(fallbackResult)) {
    return fallbackResult;
  }

  console.error(
    `Both primary and fallback Telebirr verification failed for ${reference}`,
  );
  return null;
}

// ---------- Dashen ----------

async function verifyDashenWithBank(
  transactionReference: string,
): Promise<DashenVerifyResult> {
  const url =
    `https://receipt.dashensuperapp.com/receipt/${transactionReference}`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          Accept: "application/pdf",
        },
      },
      30000,
    );

    if (!res.ok) {
      console.error("Dashen PDF fetch failed:", res.status);
      return {
        success: false,
        error: `Failed to fetch Dashen receipt: HTTP ${res.status}`,
      };
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    return await parseDashenReceiptFromPdf(buffer);
  } catch (error) {
    console.error("Error fetching Dashen PDF:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function parseDashenReceiptFromPdf(
  pdfBuffer: Uint8Array,
): Promise<DashenVerifyResult> {
  try {
    const text = await extractPdfText(pdfBuffer);
    const rawText = text.replace(/\s+/g, " ").trim();

    const senderNameMatch = rawText.match(
      /Sender\s*Name\s*:?\s*(.*?)\s+(?:Sender\s*Account|Account)/i,
    );
    const senderName = senderNameMatch?.[1]?.trim();

    const senderAccountMatch = rawText.match(
      /Sender\s*Account\s*(?:Number)?\s*:?\s*([A-Z0-9\*\-]+)/i,
    );
    const senderAccountNumber = senderAccountMatch?.[1]?.trim();

    const transactionChannelMatch = rawText.match(
      /Transaction\s*Channel\s*:?\s*(.*?)\s+(?:Service|Type)/i,
    );
    const transactionChannel = transactionChannelMatch?.[1]?.trim();

    const serviceTypeMatch = rawText.match(
      /Service\s*Type\s*:?\s*(.*?)\s+(?:Narrative|Description)/i,
    );
    const serviceType = serviceTypeMatch?.[1]?.trim();

    const narrativeMatch = rawText.match(
      /Narrative\s*:?\s*(.*?)\s+(?:Receiver|Phone)/i,
    );
    const narrative = narrativeMatch?.[1]?.trim();

    const receiverNameMatch = rawText.match(
      /Receiver\s*Name\s*:?\s*(.*?)\s+(?:Phone|Institution)/i,
    );
    const receiverName = receiverNameMatch?.[1]?.trim();

    const phoneNoMatch = rawText.match(
      /Phone\s*(?:No\.?|Number)?\s*:?\s*([\+\d\-\s]+)/i,
    );
    const phoneNo = phoneNoMatch?.[1]?.trim();

    const institutionNameMatch = rawText.match(
      /Institution\s*Name\s*:?\s*(.*?)\s+(?:Transaction|Reference)/i,
    );
    const institutionName = institutionNameMatch?.[1]?.trim();

    const transactionReferenceMatch = rawText.match(
      /Transaction\s*Reference\s*:?\s*([A-Z0-9\-]+)/i,
    );
    const transactionReference = transactionReferenceMatch?.[1]?.trim();

    const transferReferenceMatch = rawText.match(
      /Transfer\s*Reference\s*:?\s*([A-Z0-9\-]+)/i,
    );
    const transferReference = transferReferenceMatch?.[1]?.trim();

    const dateMatch = rawText.match(
      /Transaction\s*Date\s*(?:&\s*Time)?\s*:?\s*([\d\/\-,: ]+(?:[APM]{2})?)/i,
    );
    const dateRaw = dateMatch?.[1]?.trim();
    const transactionDate = dateRaw ? new Date(dateRaw) : undefined;

    const transactionAmount = parseNumber(
      rawText.match(
        /Transaction\s*Amount\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const serviceCharge = parseNumber(
      rawText.match(
        /Service\s*Charge\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const exciseTax = parseNumber(
      rawText.match(
        /Excise\s*Tax\s*(?:\(15%\))?\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const vat = parseNumber(
      rawText.match(
        /VAT\s*(?:\(15%\))?\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const penaltyFee = parseNumber(
      rawText.match(
        /Penalty\s*Fee\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const incomeTaxFee = parseNumber(
      rawText.match(
        /Income\s*Tax\s*Fee\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const interestFee = parseNumber(
      rawText.match(
        /Interest\s*Fee\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const stampDuty = parseNumber(
      rawText.match(
        /Stamp\s*Duty\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const discountAmount = parseNumber(
      rawText.match(
        /Discount\s*Amount\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;
    const total = parseNumber(
      rawText.match(
        /Total\s*(?:ETB|Birr)?\s*([\d,]+\.?\d*)/i,
      )?.[1],
    ) ?? undefined;

    const formattedSenderName = toTitleCase(senderName);
    const formattedReceiverName = toTitleCase(receiverName);
    const formattedInstitutionName = toTitleCase(institutionName);

    if (transactionReference && transactionAmount != null) {
      return {
        success: true,
        senderName: formattedSenderName,
        senderAccountNumber,
        transactionChannel,
        serviceType,
        narrative,
        receiverName: formattedReceiverName,
        phoneNo,
        institutionName: formattedInstitutionName,
        transactionReference,
        transferReference,
        transactionDate: transactionDate?.toISOString(),
        transactionAmount,
        serviceCharge,
        exciseTax,
        vat,
        penaltyFee,
        incomeTaxFee,
        interestFee,
        stampDuty,
        discountAmount,
        total,
      };
    }

    return {
      success: false,
      error:
        "Could not extract required fields (Transaction Reference and Amount) from Dashen PDF.",
    };
  } catch (error) {
    console.error("Dashen PDF parsing failed:", error);
    return { success: false, error: "Error parsing Dashen PDF data" };
  }
}

// ---------- Abyssinia ----------

async function verifyAbyssiniaWithBank(
  reference: string,
  suffix: string,
): Promise<SimpleVerifyResult> {
  const apiUrl =
    `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${reference}${suffix}`;

  try {
    const res = await fetchWithTimeout(
      apiUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          Accept: "application/json, text/plain, */*",
        },
      },
      30000,
    );

    if (!res.ok) {
      console.error("Abyssinia API HTTP error:", res.status);
      return {
        success: false,
        error: `Failed to fetch Abyssinia receipt: HTTP ${res.status}`,
      };
    }

    const jsonData = await res.json();
    if (!jsonData || !jsonData.header || !jsonData.body) {
      return {
        success: false,
        error: "Invalid response structure from Abyssinia API",
      };
    }

    if (jsonData.header.status !== "success") {
      return {
        success: false,
        error: `API returned error status: ${jsonData.header.status}`,
      };
    }

    if (!Array.isArray(jsonData.body) || jsonData.body.length === 0) {
      return {
        success: false,
        error: "No transaction data found in Abyssinia response body",
      };
    }

    const transactionData = jsonData.body[0];

    const transferredAmountStr =
      transactionData["Transferred Amount"] as string | undefined;
    const amount = transferredAmountStr
      ? parseFloat(transferredAmountStr.replace(/[^\d.]/g, ""))
      : undefined;

    const transactionDateStr =
      transactionData["Transaction Date"] as string | undefined;
    const date = transactionDateStr ? new Date(transactionDateStr) : undefined;

    const payer = transactionData["Payer's Name"] as string | undefined;
    const sourceAccount = transactionData["Source Account"] as
      | string
      | undefined;
    const sourceAccountName = transactionData["Source Account Name"] as
      | string
      | undefined;
    const referenceValue = transactionData["Transaction Reference"] as
      | string
      | undefined;
    const narrative = transactionData["Narrative"] as string | undefined;

    const result: SimpleVerifyResult = {
      success: true,
      payer: payer || undefined,
      payerAccount: sourceAccount || undefined,
      receiver: sourceAccountName || undefined,
      // For Sosha, treat Source Account as the account receiving funds (adjust if needed)
      receiverAccount: sourceAccount || undefined,
      amount,
      date: date?.toISOString(),
      reference: referenceValue || undefined,
      reason: narrative || null,
    };

    if (!result.reference || !result.amount || !result.payer) {
      return {
        success: false,
        error: "Missing essential fields in Abyssinia transaction data",
      };
    }

    return result;
  } catch (error) {
    console.error("Error in verifyAbyssinia:", error);
    return {
      success: false,
      error: "Failed to verify Abyssinia transaction",
    };
  }
}

// ---------- CBE Birr ----------

async function verifyCbeBirrWithBank(
  receiptNumber: string,
  phoneNumber: string,
  bankToken: string,
): Promise<CbeBirrReceipt | { success: false; error: string }> {
  const url =
    `https://cbepay1.cbe.com.et/aureceipt?TID=${receiptNumber}&PH=${phoneNumber}`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${bankToken}`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          Accept: "application/pdf",
        },
      },
      30000,
    );

    if (!res.ok) {
      console.error("CBE Birr PDF fetch failed:", res.status);
      return {
        success: false,
        error: `Failed to fetch CBE Birr receipt: HTTP ${res.status}`,
      };
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    const pdfText = await extractPdfText(buffer);

    const parsed = parseCbeBirrReceiptFromText(pdfText, receiptNumber);
    if (!parsed) {
      return {
        success: false,
        error: "Failed to parse receipt data from CBE Birr PDF",
      };
    }

    return parsed;
  } catch (error) {
    console.error("Error in verifyCbeBirrWithBank:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function parseCbeBirrReceiptFromText(
  pdfText: string,
  receiptNumberFromRequest: string,
): CbeBirrReceipt | null {
  const text = pdfText;

  const extractValue = (pattern: RegExp): string => {
    const match = text.match(pattern);
    const result = match && match[1] ? match[1].trim() : "";
    return result;
  };

  const customerName =
    extractValue(/Customer Name:\s*([^\n\r]+?)(?=\s*Region:)/i) || "";
  const debitAccount = "";
  const creditAccount =
    extractValue(
      /Credit Account[\s\n\r]+([^\n\r]+?)(?=\s*Receiver Name)/i,
    ) || "";
  const receiverName =
    extractValue(
      /Receiver Name[\s\n\r]+([^\n\r]+?)(?=\s*Order ID)/i,
    ) || creditAccount;

  const orderId =
    extractValue(/Order ID[\s\n\r]+([A-Z0-9]+)/i) ||
    extractValue(/(FT\d+[A-Z0-9]*)/i) || "";

  const transactionStatus =
    extractValue(
      /Transaction Status[\s\n\r]+([^\n\r]+?)(?=\s*Reference)/i,
    ) || "Completed";

  const reference =
    extractValue(
      /Reference[\s\n\r]+([^\n\r]+?)(?=\s*Receipt Number)/i,
    ) || orderId;

  const receiptNumberParsed =
    extractValue(/Receipt Number[\s\n\r]+([A-Z0-9]+)/i) ||
    receiptNumberFromRequest;

  const transactionDate =
    extractValue(
      /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i,
    ) || "";

  const amount =
    extractValue(/Amount[\s\n\r]*([\d,]+\.\d{2})/i) ||
    extractValue(/([\d,]+\.\d{2})/i) || "";

  const paidAmount =
    extractValue(/Paid amount[\s\n\r]*([\d,]+\.\d{2})/i) || amount;

  const serviceCharge =
    extractValue(/Service Charge[\s\n\r]*([\d,]+\.\d{2})/i) || "0.00";

  const vat =
    extractValue(/VAT[\s\n\r]*([\d,]+\.\d{2})/i) || "0.00";

  const totalPaidAmount =
    extractValue(
      /Total Paid Amount[\s\n\r]*([\d,]+\.\d{2})/i,
    ) || amount;

  const paymentReason =
    extractValue(
      /TransferFromBankToMM by Customer to Customer/i,
    ) ||
    "TransferFromBankToMM by Customer to Customer";

  const paymentChannel =
    extractValue(/USSD/i) || "USSD";

  if (!customerName && !receiptNumberParsed && !amount) {
    return null;
  }

  return {
    customerName,
    debitAccount,
    creditAccount,
    receiverName,
    orderId,
    transactionStatus,
    reference,
    receiptNumber: receiptNumberParsed,
    transactionDate,
    amount,
    paidAmount,
    serviceCharge,
    vat,
    totalPaidAmount,
    paymentReason,
    paymentChannel,
  };
}

// ---------- HTTP handlers ----------

async function handleVerifyCbe(
  req: Request,
  apiKey: ApiKeyRecord,
): Promise<Response> {
  const body = await parseJsonBody(req);
  if (
    !body || typeof body.reference !== "string" ||
    typeof body.accountSuffix !== "string"
  ) {
    return jsonResponse(
      {
        success: false,
        error: "reference and accountSuffix are required",
      },
      400,
    );
  }

  const reference: string = body.reference;
  const accountSuffix: string = body.accountSuffix;
  const bank = "CBE";

  const dupeCheck = await ensureReceiptNotUsed(reference, bank);
  if (!dupeCheck.ok) {
    return jsonResponse({ success: false, error: dupeCheck.message }, 400);
  }

  const verifyResult = await verifyCbeWithBank(reference, accountSuffix);
  if (!verifyResult.success) {
    return jsonResponse(
      {
        success: false,
        error: verifyResult.error ||
          "Failed to verify CBE receipt",
      },
      502,
    );
  }

  const receiverAccount = verifyResult.receiverAccount ?? "";
  if (!receiverAccount.endsWith("56042704")) {
    return jsonResponse(
      {
        success: false,
        error: "Receipt is not for Sosha Hops account.",
      },
      400,
    );
  }

  const verifiedReceiptId = await insertVerifiedReceipt({
    referenceNumber: reference,
    bank,
    amount: verifyResult.amount ?? null,
    receiverAccount,
    orderId: typeof body.orderId === "string" ? body.orderId : null,
    branchId: typeof body.branchId === "string" ? body.branchId : null,
    verifiedBy: apiKey.name,
    manualOverride: body.manualOverride === true,
  });

  return jsonResponse({
    success: true,
    bank,
    referenceNumber: reference,
    verifiedReceiptId,
    receipt: verifyResult,
  });
}

async function handleVerifyTelebirr(
  req: Request,
  apiKey: ApiKeyRecord,
): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body || typeof body.reference !== "string") {
    return jsonResponse(
      { success: false, error: "reference is required" },
      400,
    );
  }

  const reference: string = body.reference;
  const bank = "TELEBIRR";

  const dupeCheck = await ensureReceiptNotUsed(reference, bank);
  if (!dupeCheck.ok) {
    return jsonResponse({ success: false, error: dupeCheck.message }, 400);
  }

  const receipt = await verifyTelebirrWithBank(reference);
  if (!receipt) {
    return jsonResponse(
      {
        success: false,
        error: "Receipt not found or could not be processed.",
      },
      404,
    );
  }

  const amount = parseNumber(receipt.settledAmount);

  const verifiedReceiptId = await insertVerifiedReceipt({
    referenceNumber: reference,
    bank,
    amount,
    receiverAccount: receipt.creditedPartyAccountNo || null,
    verifiedBy: apiKey.name,
    manualOverride: body.manualOverride === true,
  });

  return jsonResponse({
    success: true,
    bank,
    referenceNumber: reference,
    verifiedReceiptId,
    receipt,
  });
}

async function handleVerifyDashen(
  req: Request,
  apiKey: ApiKeyRecord,
): Promise<Response> {
  const body = await parseJsonBody(req);
  if (!body || typeof body.reference !== "string") {
    return jsonResponse(
      { success: false, error: "reference is required" },
      400,
    );
  }

  const reference: string = body.reference;
  const bank = "DASHEN";

  const dupeCheck = await ensureReceiptNotUsed(reference, bank);
  if (!dupeCheck.ok) {
    return jsonResponse({ success: false, error: dupeCheck.message }, 400);
  }

  const result = await verifyDashenWithBank(reference);
  if (!result.success) {
    return jsonResponse(
      {
        success: false,
        error: result.error || "Failed to verify Dashen receipt",
      },
      502,
    );
  }

  const verifiedReceiptId = await insertVerifiedReceipt({
    referenceNumber: reference,
    bank,
    amount: result.transactionAmount ?? null,
    receiverAccount: result.phoneNo ?? null,
    verifiedBy: apiKey.name,
    manualOverride: body.manualOverride === true,
  });

  return jsonResponse({
    success: true,
    bank,
    referenceNumber: reference,
    verifiedReceiptId,
    receipt: result,
  });
}

async function handleVerifyAbyssinia(
  req: Request,
  apiKey: ApiKeyRecord,
): Promise<Response> {
  const body = await parseJsonBody(req);
  if (
    !body || typeof body.reference !== "string" ||
    typeof body.suffix !== "string"
  ) {
    return jsonResponse(
      {
        success: false,
        error: "reference and suffix are required",
      },
      400,
    );
  }

  const reference: string = body.reference;
  const suffix: string = body.suffix;
  const bank = "ABYSSINIA";

  const dupeCheck = await ensureReceiptNotUsed(reference, bank);
  if (!dupeCheck.ok) {
    return jsonResponse({ success: false, error: dupeCheck.message }, 400);
  }

  const result = await verifyAbyssiniaWithBank(reference, suffix);
  if (!result.success) {
    return jsonResponse(
      {
        success: false,
        error: result.error ||
          "Failed to verify Abyssinia receipt",
      },
      502,
    );
  }

  const receiverAccount = result.receiverAccount ?? "";
  if (!receiverAccount.endsWith("16408")) {
    return jsonResponse(
      {
        success: false,
        error: "Receipt is not for Sosha Hops account.",
      },
      400,
    );
  }

  const verifiedReceiptId = await insertVerifiedReceipt({
    referenceNumber: reference,
    bank,
    amount: result.amount ?? null,
    receiverAccount,
    verifiedBy: apiKey.name,
    manualOverride: body.manualOverride === true,
  });

  return jsonResponse({
    success: true,
    bank,
    referenceNumber: reference,
    verifiedReceiptId,
    receipt: result,
  });
}

function isValidEthiopianPhone(phone: string): boolean {
  return /^251\d{9}$/.test(phone);
}

async function handleVerifyCbeBirr(
  req: Request,
  apiKey: ApiKeyRecord,
): Promise<Response> {
  const body = await parseJsonBody(req);
  if (
    !body || typeof body.receiptNumber !== "string" ||
    typeof body.phoneNumber !== "string"
  ) {
    return jsonResponse(
      {
        success: false,
        error: "receiptNumber and phoneNumber are required",
      },
      400,
    );
  }

  const receiptNumber: string = body.receiptNumber;
  const phoneNumber: string = body.phoneNumber;
  const bank = "CBEBIRR";

  if (!isValidEthiopianPhone(phoneNumber)) {
    return jsonResponse(
      {
        success: false,
        error:
          "Invalid Ethiopian phone number format. Must start with 251 and be 12 digits total",
      },
      400,
    );
  }

  const dupeCheck = await ensureReceiptNotUsed(receiptNumber, bank);
  if (!dupeCheck.ok) {
    return jsonResponse({ success: false, error: dupeCheck.message }, 400);
  }

  // External bank bearer token - do NOT confuse with Sosha x-api-key
  const bankToken =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    req.headers.get("x-cbe-birr-token") ??
    "";
  if (!bankToken) {
    return jsonResponse(
      {
        success: false,
        error:
          "Bank bearer token is required in Authorization header or x-cbe-birr-token header",
      },
      401,
    );
  }

  const result = await verifyCbeBirrWithBank(
    receiptNumber,
    phoneNumber,
    bankToken,
  );
  if ("success" in result && result.success === false) {
    return jsonResponse(
      {
        success: false,
        error: result.error,
      },
      502,
    );
  }

  const amount = parseNumber(result.paidAmount || result.amount);

  const verifiedReceiptId = await insertVerifiedReceipt({
    referenceNumber: receiptNumber,
    bank,
    amount,
    receiverAccount: result.creditAccount || null,
    verifiedBy: apiKey.name,
    manualOverride: body.manualOverride === true,
  });

  return jsonResponse({
    success: true,
    bank,
    referenceNumber: receiptNumber,
    verifiedReceiptId,
    receipt: result,
  });
}

// ---------- Edge Function entrypoint ----------

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // Minimal health check (no API key required)
  if (method === "GET" && pathname.endsWith("/health")) {
    return jsonResponse({
      status: "ok",
      service: "sosha-verifier",
      timestamp: new Date().toISOString(),
    });
  }

  const apiKeyHeader = req.headers.get("x-api-key");
  if (!apiKeyHeader) {
    return jsonResponse(
      { success: false, error: "x-api-key header is required" },
      401,
    );
  }

  let apiKey: ApiKeyRecord | null = null;
  try {
    apiKey = await getApiKeyRecord(apiKeyHeader);
  } catch (error) {
    console.error("Error during API key validation:", error);
    return jsonResponse(
      { success: false, error: "Internal server error" },
      500,
    );
  }

  if (!apiKey) {
    return jsonResponse(
      { success: false, error: "Invalid API key" },
      401,
    );
  }

  try {
    if (method === "POST" && pathname.endsWith("/verify/cbe")) {
      return await handleVerifyCbe(req, apiKey);
    }

    if (method === "POST" && pathname.endsWith("/verify/telebirr")) {
      return await handleVerifyTelebirr(req, apiKey);
    }

    if (method === "POST" && pathname.endsWith("/verify/dashen")) {
      return await handleVerifyDashen(req, apiKey);
    }

    if (method === "POST" && pathname.endsWith("/verify/abyssinia")) {
      return await handleVerifyAbyssinia(req, apiKey);
    }

    if (method === "POST" && pathname.endsWith("/verify/cbebirr")) {
      return await handleVerifyCbeBirr(req, apiKey);
    }

    return jsonResponse(
      { success: false, error: "Not found" },
      404,
    );
  } catch (error) {
    console.error("Unhandled error in Sosha Verifier:", error);
    return jsonResponse(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});