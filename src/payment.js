import {
  decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
  HTTPFacilitatorClient,
} from "@x402/core/http";
import { SettleError, VerifyError } from "@x402/core/types";
import { resource } from "./metadata.js";

const facilitators = {
  payai: "https://facilitator.payai.network",
  dexter: "https://x402.dexter.cash",
};
const address = /^0x[\da-fA-F]{40}$/;
const bytes32 = /^0x[\da-fA-F]{64}$/;
const signature = /^0x(?:[\da-fA-F]{2}){64,1024}$/;
const timestamp = /^\d{1,16}$/;
const pending = new Set(["settlement_pending", "duplicate_settlement"]);
const expiry = 2 * 24 * 60 * 60 * 1_000;

function sameAddress(left, right) {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

export function challenge(origin, route, error) {
  const required = { x402Version: 2, resource: resource(origin, route), accepts: [route.requirement], extensions: route.extensions };
  if (error) required.error = error;
  return encodePaymentRequiredHeader(required);
}

export function readPayment(header, origin, route) {
  if (header.length > 12_288) return null;
  let decoded;
  try {
    decoded = decodePaymentSignatureHeader(header);
  } catch {
    return null;
  }
  if (decoded?.x402Version !== 2) return null;
  const { accepted, payload } = decoded;
  const endpoint = resource(origin, route);
  const { requirement, extensions } = route;
  if (accepted?.scheme !== requirement.scheme || accepted.network !== requirement.network
    || accepted.amount !== requirement.amount || !sameAddress(accepted.asset, requirement.asset)
    || !sameAddress(accepted.payTo, requirement.payTo) || accepted.maxTimeoutSeconds !== requirement.maxTimeoutSeconds
    || accepted.extra?.name !== requirement.extra.name || accepted.extra?.version !== requirement.extra.version
    || ![undefined, "eip3009"].includes(accepted.extra?.assetTransferMethod)
    || (decoded.resource !== undefined && decoded.resource?.url !== endpoint.url)) return null;

  const auth = payload?.authorization;
  if (typeof auth?.from !== "string" || !address.test(auth.from) || sameAddress(auth.from, requirement.payTo)
    || !sameAddress(auth.to, requirement.payTo) || auth.value !== requirement.amount
    || typeof auth.nonce !== "string" || !bytes32.test(auth.nonce)
    || typeof auth.validAfter !== "string" || !timestamp.test(auth.validAfter)
    || typeof auth.validBefore !== "string" || !timestamp.test(auth.validBefore)
    || typeof payload.signature !== "string" || !signature.test(payload.signature)) return null;

  // Derive catalog metadata from the server declaration and normalize the wire
  // payload so reconciliation sends the same authorization and requirements.
  return {
    x402Version: 2,
    resource: endpoint,
    accepted: requirement,
    payload: {
      authorization: {
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
      },
      signature: payload.signature,
    },
    extensions,
  };
}

export async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function makeFacilitator(name) {
  if (!Object.hasOwn(facilitators, name)) throw new Error("Unknown payment facilitator.");
  return new HTTPFacilitatorClient({ url: facilitators[name], timeoutMs: 105_000 });
}

export function verifyFailure(error) {
  return error instanceof VerifyError && [400, 402].includes(error.statusCode);
}

export function settlementFailure(error) {
  if (!(error instanceof SettleError)) return null;
  return {
    success: false,
    transaction: error.transaction,
    errorReason: [400, 402, 403].includes(error.statusCode) ? error.errorReason : "settlement_pending",
  };
}

export function settlementState(settlement, payment) {
  if (settlement?.success === false && !pending.has(settlement.errorReason) && !settlement.transaction) {
    return "declined";
  }
  if (settlement?.success !== true || settlement.network !== payment.accepted.network
    || typeof settlement.transaction !== "string" || !bytes32.test(settlement.transaction)
    || (settlement.payer !== undefined && !sameAddress(settlement.payer, payment.payload.authorization.from))
    || (settlement.amount !== undefined && settlement.amount !== payment.accepted.amount)) {
    return "pending";
  }
  return "paid";
}

export function settlementHeader(settlement, payment) {
  return encodePaymentResponseHeader({
    success: true,
    transaction: settlement.transaction,
    network: payment.accepted.network,
    payer: payment.payload.authorization.from,
    amount: payment.accepted.amount,
  });
}

export async function storeAttempt(storage, attempt) {
  await storage.transaction(async (txn) => {
    await txn.put("attempt", attempt);
    await txn.setAlarm(Date.now() + expiry);
  });
}
