
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

- `WALLET_IMPORT_PORT=3000`

- `WALLET_IMPORT_BASE_URL=http://localhost:3000`

- `VAULT_SECRET` only for legacy local vault compatibility

- `AZURE_TENANT_ID`

- `AZURE_CLIENT_ID`

- `AZURE_CLIENT_SECRET`

- `AZURE_KEY_VAULT_URL`

- `AZURE_KEY_NAME=wallet-vault-dev`

- `AZURE_KEY_WRAP_ALGORITHM=RSA-OAEP-256`




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

13. Add FCFS speed layer:

    - private RPC

    - prebuilt tx

    - gas strategy

    - retry strategy

    - parallel wallet execution

14. Add subscription/user access system.

15. Deploy backend safely.



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

Claim an old ownerless wallet record:

`npm run wallet:claim -- azuretest1 7558749410`



TypeScript check:

`npx tsc --noEmit`
