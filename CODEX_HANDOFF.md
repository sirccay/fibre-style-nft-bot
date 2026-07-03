
# NFT Telegram Minting Bot — Codex Handoff



## Project summary



This is a Node.js + TypeScript Telegram bot for NFT minting and marketplace actions.



Core stack:

- Node.js

- TypeScript

- Telegraf

- ethers.js v6

- OpenSea API

- OpenSea SDK

- Azure Identity

- Azure Key Vault Keys

- Telegram wallet import flow

- Provider-neutral envelope encryption with Azure Key Vault as the first KMS provider



## Current implemented features



### Telegram bot

- `/start` menu

- Admin lock using `ADMIN_TELEGRAM_ID`

- `/whoami`

- Inline button menus

- Telegram slash command menu should be managed manually through BotFather.

- Automatic startup registration is disabled by default. Set `REGISTER_TELEGRAM_COMMANDS=true` only if you want the bot to attempt `setMyCommands` on startup.

- `/help` command with command examples



### Wallet vault

- Provider-neutral envelope encryption implemented for new wallet records.

- Wallets stored in `data/vault.json`.

- `.env` and `data/*.json` are gitignored.

- Current vault version:

  - `encryptionVersion: "kms-envelope-v1"`

  - `kmsProvider: "azure-key-vault"`

  - `kmsKeyRef` stores the Azure vault URL and key name

  - one per-wallet 32-byte DEK generated locally with `crypto.randomBytes(32)`

  - private key encrypted with AES-256-GCM using the DEK

  - DEK wrapped by Azure Key Vault with `CryptographyClient.wrapKey()`

  - wrapped DEK stored as base64 in `wrappedDek`

  - private key decrypted only in memory at signing time

  - `ownerTelegramId` is required on new wallet records

  - decrypt/sign audit logging in `data/kmsAuditLog.json`

  - temporary legacy local vault read support remains for old records that require `VAULT_SECRET`

- Old ownerless wallet records can be claimed locally without re-importing private keys:

  `npm run wallet:claim -- azuretest1 7558749410`

- If a wallet already has an owner, use `--force` only after verifying the reassignment:

  `npm run wallet:claim -- azuretest1 7558749410 --force`

- The claim script updates only `ownerTelegramId`, writes a `wallet_owner_claimed` audit entry, and does not decrypt, unwrap, re-encrypt, or modify `encryptedPrivateKey`, `wrappedDek`, `kmsProvider`, or `kmsKeyRef`.



### Wallet onboarding

- Telegram private-chat wallet import is the current onboarding path.

- Commands:

  `/addwallet`

  `/importwallet`

  `/import_wallet`

- Supported Telegram import formats:

  `/addwallet walletLabel privateKey`

  `/addwallet` followed by one private key per line

  `/addwallet` followed by `walletLabel privateKey` rows

- Telegram wallet import only works in private chat, attempts to delete the incoming private-key message, stores each wallet with `ownerTelegramId = ctx.from.id`, and encrypts through Azure Key Vault envelope encryption before writing to `data/vault.json`.

- Invalid rows, duplicate labels, and duplicate wallet addresses for the same owner are skipped without echoing private keys.

- Terminal wallet add remains available:

  `npm run wallet:add`

- Local owner claim command for old vault records:

  `npm run wallet:claim -- walletLabel ownerTelegramId`


### Wallet management

- `/wallets` lists only wallets owned by `ctx.from.id`, with label, short address, status, and inline View/Balance/NFT buttons.

- `/wallet walletLabel` shows owner-scoped wallet details without decrypting or exposing vault internals.

- `/balance walletLabel [network]` checks native ETH balance only. Default network is Sepolia; `mainnet` is allowed for read-only balance checks.

- `/renamewallet oldLabel newLabel` renames an owner-scoped wallet without decrypting or re-encrypting private key material.

- `/deletewallet walletLabel` creates a 10-minute owner-scoped confirmation session. Confirming archives the wallet locally; it does not affect the wallet on-chain.

- Archived wallets keep encrypted data intact but are blocked from signing and normal wallet address lookup flows.

- Wallet management audit events include `wallet_viewed`, `wallet_balance_checked`, `wallet_renamed`, `wallet_delete_requested`, `wallet_delete_confirmed`, `wallet_delete_cancelled`, and `command_menu_registered`.



### Sepolia minting

- Test NFT contract deployed on Sepolia:

  `0x73Ca24ad5D2Db0f1C5d0457895B06F429468cA92`

- Bot can mint test NFT:

  `/minttest wallet1 1`

- Bot detects minted token IDs from Transfer logs.

- Mint history saved to `data/mints.json`.

- `/nfts wallet1` shows minted test NFTs.


### Real mint engine

- Real mint previews and confirmation sessions are implemented for simple payable mint functions only:

  - `mint(uint256)`

  - `publicMint(uint256)`

  - `mintPublic(uint256)`

  - `mintTo(address,uint256)`

  - `publicMint(address,uint256)`

- Direct commands:

  - `/mainmintpreview wallet1 0xCONTRACT mint(uint256) 1 0.03 mainnet`

  - `/mainmint wallet1 0xCONTRACT mint(uint256) 1 0.03 mainnet`

- Saved mint target commands:

  - `/addminttarget whaleMint 0xCONTRACT mint(uint256) 1 0.03 mainnet`

  - `/minttargets`

  - `/minttarget targetId`

  - `/updateminttarget targetId publicMint(uint256) 2 0.01 mainnet`

  - `/deleteminttarget targetId`

  - `/minttargetpreview targetId wallet1`

  - `/minttargetnow targetId wallet1`

- Mint history commands:

  - `/minthistory`

  - `/mintstatus runId`

- Mint status command:

  - `/mintingstatus`

- Real mint helper files:

  - `src/mintEngine.ts`

  - `src/mintTargets.ts`

  - `src/mintRuns.ts`

- Mint targets are saved in `data/mintTargets.json` and are owner-scoped to `ctx.from.id`.

- Mint runs are saved in `data/mintRuns.json` and are owner-scoped to `ctx.from.id`.

- `/mainmint` and `/minttargetnow` create 10-minute owner-scoped confirmation sessions. Final confirm buttons are single-use, wrong-user clicks are blocked, and cancelled/expired sessions cannot send transactions.

- Ethereum mainnet mint sends are locked separately by:

  `ALLOW_MAINNET_MINTING=false`

- Sepolia mints can be submitted without `ALLOW_MAINNET_MINTING=true`; mainnet mints cannot.

- The mint engine uses `ETH_MAINNET_RPC_URL` for mainnet and `SEPOLIA_RPC_URL` or `ETH_SEPOLIA_RPC_URL` for Sepolia. It never uses `ethers.getDefaultProvider`.

- Regression check for generic mint gas estimation:

  `/mainmintpreview wallet1 0x73Ca24ad5D2Db0f1C5d0457895B06F429468cA92 mint(uint256) 1 0.01 sepolia`

  Expected: estimated gas should appear if the wallet is eligible and the contract accepts the selected mint function. If the selected function is wrong for that contract, the preview should show a redacted failure reason instead of a raw transaction object.

- Allowlist, Merkle proof, signature minting, and arbitrary ABI support are intentionally not implemented yet.

- Mint audit events include `mint_previewed`, `mint_confirmation_created`, `mint_blocked`, `mint_submitted`, `mint_confirmed`, `mint_failed`, `mint_target_created`, `mint_target_updated`, `mint_target_archived`, and `mint_run_viewed`.

### Mint scheduling and watcher

- Scheduled mint jobs are saved in `data/mintJobs.json` and are owner-scoped to `ctx.from.id`.

- Commands:

  - `/setminttype targetId manual|team|holder|gtd|fcfs|public`

  - `/schedulemint targetId wallet1 2026-07-04T18:00:00Z [watch|auto]`

  - `/schedulemintphase targetId wallet1 public [watch|auto]`

  - `/mintwatchstatus`

  - `/mintjob jobId`

  - `/cancelmintjob jobId`

  - `/runmintcheck jobId`

  - `/runmintjob jobId`

  - `/schedulerstatus`

- Mint job schema includes `jobId`, `ownerTelegramId`, `targetId`, target/wallet snapshots, chain/contract/function/quantity/price, `mintType`, optional `phaseTypeEstimate`, `startTimeISO`, optional `endTimeISO`, `status`, `mode`, `autoSubmit`, retry settings, attempts, last check/run fields, tx hash, and safe error reason.

- Scheduler behavior:

  - In-process scheduler starts after `bot.launch()` and does not block startup.

  - Active jobs with status `scheduled`, `watching`, or `ready` are reloaded on startup.

  - Poll interval defaults to `MINT_SCHEDULER_POLL_MS=15000` and is clamped to at least 5000ms.

  - Watch mode runs readiness checks and alerts the user when ready. It does not send transactions.

  - Auto mode may submit only when readiness checks pass and safety locks allow it.

  - Retries are capped at 5. Defaults: manual 0/3000ms, team 1/3000ms, holder 2/3000ms, GTD 2/3000ms, FCFS 3/1000ms, public 2/2000ms.

- Scheduled Ethereum mainnet auto-minting requires both:

  `ALLOW_MAINNET_MINTING=true`

  `ALLOW_SCHEDULED_MAINNET_MINTING=true`

- Sepolia scheduled test minting can auto-submit without mainnet locks.

- Manual `/runmintjob` creates the same 10-minute owner-scoped confirmation session as `/minttargetnow`; final confirmation is single-use and mainnet still requires `ALLOW_MAINNET_MINTING=true`.

- Scheduler readiness checks are read-only until auto-submit is explicitly allowed. They validate owner-scoped wallet access, wallet snapshot match, target availability, phase status, native balance for mint price, and gas estimation. No raw tx payloads or secrets are logged.


### Mint parser and phase detector

- Mint link parser command:

  - `/parsemintlink URL_OR_TEXT`

- Draft target creation from parser:

  - `/addmintfromlink URL_OR_TEXT mintName`

- OpenSea contract resolver:

  - `/resolvecontract collectionSlug_or_OpenSea_URL`

- Function detection commands:

  - `/detectmintfunction 0xCONTRACT mainnet`

  - `/detecttargetfunction targetId`

- Phase and readiness commands:

  - `/checkmintphase targetId`

  - `/checkminteligibility targetId wallet1`

  - `/checkmintreadiness targetId wallet1`

- Target metadata refresh:

  - `/refreshtarget targetId`

- Parser status:

  - `/parserstatus`

- Direct private-chat link parsing is enabled. Pasting a supported OpenSea/Zora/explorer link in a private chat runs the same safe parser output as `/parsemintlink`. Commands still go to their command handlers, group chats are ignored, and private-key-shaped `0x` + 64 hex values are not parsed.

- Supported parser inputs:

  - OpenSea collection URLs

  - OpenSea collection overview/mint URLs, including `/collection/{slug}/overview` and `/collection/{slug}/mint`

  - OpenSea asset URLs

  - Zora collect URLs where chain/address is visible

  - Etherscan, Basescan, Arbiscan, and Polygonscan address links

  - raw `0x...` contract addresses

  - generic URL/text with a visible contract address

- Function detection is read-only and scans runtime bytecode for selectors of the supported mint functions. Selector presence is not proof the function is callable.

- Phase detection is read-only and probes common boolean, time, price, and supply view functions with `eth_call`.

- Phase type estimates support team, holder, GTD, FCFS, and public phase aliases. These are evidence-based estimates only.

- OpenSea mint page metadata fallback is enabled. For public OpenSea collection/mint pages, the parser now attempts safe public HTML/embedded JSON extraction with no cookies, no auth, no headless browser, and a short timeout. It can store/display mint status, minted supply progress, current stage, stage schedule, raw time text, price text, wallet limit text, and eligibility text when the public page exposes them.

- The detector now has two real tiers:

  - Tier 1: Reservoir collection lookup with `includeMintStages=true` when `RESERVOIR_API_KEY` is configured.

  - Tier 2: on-chain fallback using RPC, Etherscan V2 ABI lookup when `ETHERSCAN_API_KEY` is configured, bytecode selector scan, 4byte lookup, common getter probes, and recent transaction price inference when possible.

- Raw address input probes configured detector RPC chains and marks chain confidence lower if the same contract address has code on more than one configured chain.

- Supported detector chain config is in `src/mintDetectorV2.ts`. Currently configured chains are Ethereum mainnet, Base, Arbitrum, Polygon, and Sepolia. RPC env vars include `ETH_MAINNET_RPC_URL`, `BASE_RPC_URL`/`ETH_BASE_RPC_URL`, `ARBITRUM_RPC_URL`/`ETH_ARBITRUM_RPC_URL`, `POLYGON_RPC_URL`/`ETH_POLYGON_RPC_URL`, and `SEPOLIA_RPC_URL`/`ETH_SEPOLIA_RPC_URL`.

- Optional detector API env vars:

  - `RESERVOIR_API_KEY`

  - `OPENSEA_API_KEY`

  - `ETHERSCAN_API_KEY`

- If `RESERVOIR_API_KEY` is configured, the parser attempts Reservoir mint-stage lookup before falling back to on-chain/page metadata. Reservoir is optional and failures/401/403/429 responses should not stop the bot.

- Parser-created targets save OpenSea mint schedule metadata under `target.detectedMetadata.openSeaMint`. If OpenSea only exposes a USD price, `priceEth` is not guessed or stored; complete the ETH price manually with `/updateminttarget`.

- If OpenSea mint metadata is detected but the contract address is still unknown, `/addmintfromlink` saves an incomplete draft target with the source URL, slug, schedule, and price metadata. Complete it later with `/updateminttarget targetId 0xCONTRACT functionSignature quantity priceEth chain` or create a manual target with `/addminttarget`.

- Regression check for OpenSea mint stage parsing:

  `/parsemintlink https://opensea.io/collection/fuzzlingss/overview`

  Expected: when OpenSea public page metadata is available, the reply should include Fuzzlings mint status, minted supply progress, current Public stage price/limit, Team/GTD/Public schedule rows, and final Phase should summarize the current live Public stage as `public_phase` with high confidence. If OpenSea blocks or omits public metadata, the reply should stay safe and show unknown/warnings instead of failing.

- Parser-created mint targets may be incomplete. Complete them with `/updateminttarget targetId functionSignature quantity priceEth chain` or `/updateminttarget targetId 0xCONTRACT functionSignature quantity priceEth chain` before `/minttargetpreview` or `/minttargetnow`.

- Parser commands do not send transactions, do not schedule mints, and do not bypass project mint rules.

- Future parser upgrades still needed:

  - Etherscan ABI lookup

  - 4byte selector lookup

  - transaction-history price inference



### OpenSea read modules

Implemented commands:

- `/osfloor collection-slug`

- `/topoffer collection-slug tokenId`

- `/bestlisting collection-slug tokenId`

- `/osnft contractAddress tokenId`

- `/osportfolio wallet1`

- `/tradingstatus`



These fetch:

- collection floor

- best offer

- best listing

- NFT metadata

- owned NFTs by wallet



### Marketplace preview modules

Implemented:

- `/oslistpreview wallet1 contractAddress tokenId priceETH`

- `/listfloorpreview wallet1 collectionSlug contractAddress tokenId`

- `/listfloor wallet1 collectionSlug contractAddress tokenId`

- custom listing confirmation

- floor listing confirmation

- accept top offer confirmation



Mainnet write actions are locked by:

`ALLOW_MAINNET_TRADING=false`

- Live OpenSea listing and accept-offer actions stay blocked unless `ALLOW_MAINNET_TRADING=true`.

- Read-only floor/listing/offer previews continue to work while live trading is disabled.

- Post-mint marketplace actions validate the session owner, session status/TTL, saved wallet ownership, archived-wallet status, and on-chain NFT ownership before previews and final actions.

- Final live buttons are single-use once the live action begins. If mainnet trading is disabled, the action is blocked before the session is consumed.

- OpenSea result replies summarize public tx/order hashes only; raw SDK payloads and signed data are not echoed.

- Marketplace audit events include `opensea_listing_previewed`, `opensea_custom_listing_previewed`, `opensea_listing_confirmed`, `opensea_listing_blocked`, `opensea_top_offer_checked`, `opensea_accept_offer_previewed`, `opensea_accept_offer_confirmed`, `opensea_accept_offer_blocked`, and `opensea_action_failed`.


### Post-mint action menu

Implemented:

`/postmint wallet1 collectionSlug contractAddress tokenId`



Buttons:

- View NFT

- Floor / Best Listing

- Top Offer

- List at Floor Preview

- Confirm Floor Listing

- Custom List Preview

- Accept Top Offer

- Hold



## Important environment variables



Do NOT commit `.env`.



Expected env vars:

- `TELEGRAM_BOT_TOKEN`

- `ADMIN_TELEGRAM_ID`

- `OPENSEA_API_KEY`

- `SEPOLIA_RPC_URL` or `ETH_SEPOLIA_RPC_URL`

- `ETH_MAINNET_RPC_URL`

- `ALLOW_MAINNET_TRADING=false`

- `ALLOW_MAINNET_MINTING=false`

- `WALLET_IMPORT_PORT=3000`

- `WALLET_IMPORT_BASE_URL=http://localhost:3000`

- `VAULT_SECRET` only for legacy local vault compatibility

- `AZURE_TENANT_ID`

- `AZURE_CLIENT_ID`

- `AZURE_CLIENT_SECRET`

- `AZURE_KEY_VAULT_URL`

- `AZURE_KEY_NAME=wallet-vault-dev`

- `AZURE_KEY_WRAP_ALGORITHM=RSA-OAEP-256`

- `MAX_MULTI_MINT_WALLETS=10`

- `MAX_MULTI_MINT_CONCURRENCY=2`

- `MULTI_MINT_DELAY_MS=1000`

- `ALLOW_SCHEDULED_MAINNET_MINTING=false`




## Critical security decisions



If is not advisable to allow users to paste private keys directly into Telegram chat., then you can implement that wallet import should happen through a Telegram Mini App.



Production wallet storage should use provider-neutral envelope encryption with Azure Key Vault:

- private key encrypted with a per-wallet DEK

- DEK generated locally by the app

- DEK wrapped by Azure Key Vault

- decrypt only in memory at signing time

- log every decrypt/sign event

- no plaintext private keys in logs/errors/Sentry



## Current next tasks

Task 2 completed locally:

- Removed the previous cloud-specific KMS SDK dependency.

- Added `@azure/identity` and `@azure/keyvault-keys`.

- Added `src/audit.ts`.

- Added `src/kms.ts` with provider-neutral `wrapDek`, `unwrapDek`, and `getKmsKeyRef`.

- Refactored `src/vault.ts` to async Azure Key Vault envelope encryption APIs.

- Updated existing call sites to compile against async wallet loading.

- Read-only wallet address/ownership flows avoid private key decrypt where possible.

- Sanitized broad bot-side `console.error(error)` logging.

- `npx tsc --noEmit` passes after the Task 2 refactor.

Runtime testing still needed with real Azure credentials and a real Azure Key Vault key:

- `npm run wallet:add`

- `npm run wallet:claim -- oldOwnerlessWalletLabel 7558749410`

- `/wallets`

- wallet status button

- `/minttest wallet1 1`

- `/approvalstatus`, `/approveall`, `/revokeall`

- OpenSea preview flows that check ownership

- confirm `data/kmsAuditLog.json` records every signer/decrypt request



1. Runtime-test Azure Key Vault envelope encryption with real Azure credentials.

2. Claim old ownerless wallet records with `npm run wallet:claim -- walletLabel ownerTelegramId`.

3. Migrate or re-save any legacy local vault records into `kms-envelope-v1`.

4. Replace JSON storage with PostgreSQL or SQLite first.

5. Add rate limits around decrypt/sign actions.

6. Add production audit logs separate from main DB.

7. Host wallet import page on HTTPS.

8. Convert wallet import page into Telegram Mini App later.

9. Test real OpenSea listing with a cheap NFT owned by a vault wallet.

10. Test accept top offer flow safely.

11. Add OpenSea mint/drop link parser.

12. Add mint phase detection.

13. Continue FCFS speed layer:

    - private RPC

    - prebuilt tx

    - retry strategy

14. Add subscription/user access system.

15. Deploy backend safely.



## Task 10 multi-wallet minting and gas strategy

Task 10 adds safe multi-wallet minting for user-owned wallets only.

New files:

- `src/gasStrategy.ts` — EIP-1559 gas strategy parsing, fee override resolution, gas preview formatting.

- `src/multiMintJobs.ts` — local `data/multiMintJobs.json` storage for scheduled multi-wallet parent jobs and per-wallet child results.

Gas strategy:

- Supported modes: `auto`, `standard`, `fast`, `custom`.

- Default: `auto`, gas limit multiplier `1.15`.

- `fast` uses provider fee data with a conservative bump.

- `custom` requires `maxFeeGwei` and `maxPriorityFeeGwei`.

- Safety caps: max fee `<= 300 gwei`, max priority fee `<= 50 gwei`.

- Gas strategy is saved on mint targets and used by saved-target preview/mint, gas preview, and multi-mint flows.

Multi-wallet safety caps:

- `MAX_MULTI_MINT_WALLETS` defaults to `10` and is hard-capped at `10`.

- `MAX_MULTI_MINT_CONCURRENCY` defaults to `2` and is hard-capped at `3`.

- `MULTI_MINT_DELAY_MS` defaults to `1000` and has minimum `500`.

- No unlimited parallel transactions and no infinite retry loop.

Mainnet locks:

- Immediate `/mintmulti` requires manual confirmation; final mainnet sends still require `ALLOW_MAINNET_MINTING=true`.

- Scheduled `/schedulemintmulti ... auto` on mainnet requires both `ALLOW_MAINNET_MINTING=true` and `ALLOW_SCHEDULED_MAINNET_MINTING=true`.

- Watch mode never auto-sends transactions.

Multi-mint commands:

- `/setgas targetId auto`

- `/setgas targetId fast`

- `/setgas targetId custom 25 2`

- `/gaspreview targetId wallet1`

- `/multigaspreview targetId wallet1,wallet2`

- `/mintmulti targetId wallet1,wallet2`

- `/schedulemintmulti targetId wallet1,wallet2 2026-07-04T18:00:00Z watch`

- `/schedulemintmulti targetId wallet1,wallet2 2026-07-04T18:00:00Z auto`

- `/runmultimintjob jobId`

- `/multimintjob jobId`

- `/cancelmultimintjob jobId`

- `/multimintstatus`

Runtime notes:

- Multi-mint confirmation sessions are owner-scoped, expire after 10 minutes, and are single-use.

- Callback data contains only session IDs.

- Each wallet attempt writes a separate mint run and can succeed/fail independently.

- Per-wallet failures do not stop other wallets unless a global safety lock or target/config problem blocks the run.

- Stored multi-mint jobs do not contain private keys, DEKs, wrapped DEKs, signed transactions, RPC keys, or secrets.



## Important files



- `src/index.ts` — main Telegram bot

- `src/vault.ts` — wallet vault / KMS encryption

- `src/kms.ts` — provider-neutral KMS wrapper / Azure Key Vault implementation

- `src/audit.ts` — audit logging

- `src/claimWallet.ts` — local owner claim tool for old ownerless vault records

- `src/opensea.ts` — OpenSea read helpers

- `src/openseaTrading.ts` — OpenSea listing/offer write helpers

- `src/deployTestNft.ts` — Sepolia test NFT deploy script

- `src/addWallet.ts` — terminal wallet import script



## Testing commands



Run bot:

`npm run dev`



Deploy Sepolia test NFT:

`npm run deploy:testnft`



Add wallet through terminal:

`npm run wallet:add`

Add wallet through Telegram private chat:

`/addwallet wallet1 <private-key>`

Show wallet commands:

`/help`

List wallets:

`/wallets`

View one wallet:

`/wallet wallet1`

Check balance:

`/balance wallet1 sepolia`

Rename wallet:

`/renamewallet wallet1 mintwallet`

Archive wallet inside bot:

`/deletewallet mintwallet`

Check live trading lock/config:

`/tradingstatus`

Check multi-mint caps/config:

`/multimintstatus`

Set target gas:

`/setgas TARGET_ID fast`

Preview target gas:

`/gaspreview TARGET_ID wallet1`

Preview multiple wallets:

`/multigaspreview TARGET_ID wallet1,wallet2`

Immediate Sepolia multi-mint:

`/mintmulti TARGET_ID wallet1,wallet2`

Schedule Sepolia multi-mint watch:

`/schedulemintmulti TARGET_ID wallet1,wallet2 2026-07-04T18:00:00Z watch`

Claim an old ownerless wallet record:

`npm run wallet:claim -- azuretest1 7558749410`



TypeScript check:

`npx tsc --noEmit`
