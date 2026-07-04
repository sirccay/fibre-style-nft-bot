import assert from "node:assert/strict";
import {
  extractOpenSeaCollectionSlug,
  resolveOpenSeaContractForMintFlow
} from "./openSeaContractResolver.js";

type MockResponse = {
  status: number;
  body: unknown;
};

let nextResponse: MockResponse = { status: 200, body: {} };
let lastUrl = "";

const originalFetch = globalThis.fetch;

globalThis.fetch = (async (url: string | URL | Request) => {
  lastUrl = String(url);
  const ok = nextResponse.status >= 200 && nextResponse.status < 300;

  return new Response(JSON.stringify(nextResponse.body), {
    status: nextResponse.status,
    headers: { "content-type": "application/json" }
  });
}) as typeof fetch;

process.env.OPENSEA_API_KEY = " test-key ";

assert.equal(
  extractOpenSeaCollectionSlug("https://opensea.io/collection/miu-pets/overview?tab=items"),
  "miu-pets"
);
assert.equal(extractOpenSeaCollectionSlug("miu-pets"), "miu-pets");

nextResponse = {
  status: 200,
  body: {
    collection: "miu-pets",
    contracts: [{ address: "0x0000000000000000000000000000000000000001", chain: "ethereum" }]
  }
};

let result = await resolveOpenSeaContractForMintFlow("https://opensea.io/collection/miu-pets/overview");
assert.equal(result.status, "resolved");
assert.equal(lastUrl.includes("/api/v2/collections/miu-pets"), true);

nextResponse = {
  status: 200,
  body: {
    contracts: [
      { address: "0x0000000000000000000000000000000000000002", chain: "base" },
      { address: "0x0000000000000000000000000000000000000003", chain: "polygon" }
    ]
  }
};

result = await resolveOpenSeaContractForMintFlow("multi-chain");
assert.equal(result.status, "multiple_candidates");

nextResponse = { status: 401, body: { error: "unauthorized" } };
result = await resolveOpenSeaContractForMintFlow("auth-fail");
assert.equal(result.status, "auth_error");

nextResponse = { status: 429, body: { error: "rate limited" } };
result = await resolveOpenSeaContractForMintFlow("rate-limited");
assert.equal(result.status, "rate_limited");

nextResponse = { status: 404, body: { error: "not found" } };
result = await resolveOpenSeaContractForMintFlow("not-found");
assert.equal(["not_found", "slug_suggestions"].includes(result.status), true);

delete process.env.OPENSEA_API_KEY;
result = await resolveOpenSeaContractForMintFlow("missing-key");
assert.equal(result.status, "missing_api_key");

globalThis.fetch = originalFetch;

console.log("OpenSea contract resolver self-tests passed");
