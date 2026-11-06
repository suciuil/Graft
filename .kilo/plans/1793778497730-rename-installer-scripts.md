# Privacy notice when model prices are refreshed from LiteLLM

## Goal
Whenever model prices are refreshed (`graft prices update`, run by hand or by the installer), tell the user
up front that LiteLLM is used only as the source of one public `.json` price file and that nothing
private/confidential is sent.

## Facts verified in code (the notice must stay truthful to these)
- `updatePriceCatalog` (src/context/price-catalog.ts:265-287): one `GET` of
  `LITELLM_PRICES_URL` = `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
  (price-catalog.ts:34-35), `credentials: 'omit'`, no body, no graft headers. The whole catalog is fetched, so not
  even the model being priced leaves the machine (price-catalog.ts:5-8). Result is reduced and written to
  `priceCatalogPath()` (~/.graft/prices.json); all later lookups are local.
- The file is hosted on GitHub (raw.githubusercontent.com), not on a LiteLLM server. Like any download, the host
  sees the IP address and Node.js's default request headers - say so instead of claiming "nothing at all".
- Today `graft prices update` (src/cli.ts:1637-1655) prints nothing before downloading; the privacy wording exists
  only in `--help` (cli.ts:1640, cli-help-graft.ts:356-363) and in the installer prompt
  (install-graft-helper.ps1:1228-1229).
- Not to be confused with `GRAFT_PROVIDER=litellm` (src/ai/llm/litellm.ts): that is an LLM proxy that DOES receive
  code/prompts for `graft build --deep`. The notice must not use the word "provider" and should state it is only a
  price-list download.

## Tasks
1. `src/context/price-catalog.ts`: add and export `priceUpdateNotice(path = priceCatalogPath()): string[]`
   (placed near `updatePriceCatalog`) returning:
   ```
   ℹ️ Downloading LiteLLM's public model price list (one read-only .json file, hosted on GitHub):
      <LITELLM_PRICES_URL>
      It is used only to look up model prices. graft sends nothing to it: no code, file or repository
      names, prompts, model names, API keys, credentials or usage data.
      As with any download, the server sees only your IP address and Node.js's standard request headers.
      The prices are stored locally in <path>; every price lookup afterwards stays on this machine.
   ```
2. `src/cli.ts` `prices update` action (L1642): print `priceUpdateNotice().join("\n")` via `console.log`
   BEFORE `await updatePriceCatalog()` (outside the try, so it shows even if the download fails); import it with the
   other price-catalog imports.
3. `install-graft-helper.ps1` L1225-1232 (shown before the consent question): replace the two `Write-Host` lines with
   the same content (URL, "used only to look up model prices", explicit list of what is NOT sent, IP/headers caveat,
   stored locally). Keep the `[Y/n]` question and `-Yes` behaviour unchanged. `graft prices update` will then print
   its own notice again during the run; accepted (installer text = consent, CLI text = at download time).
4. Optional consistency (wording only, no behaviour change): `src/cli-help-graft.ts:356-363` "prices update"
   description - add "a public .json file hosted on GitHub" and "no code, prompts or keys". Do NOT change the
   `⚠️ Run the 'graft prices update' command` line in `src/context/savings.ts:187-193` (exact text pinned by
   test/savings.test.ts:224 and repeated in the agent instructions).
5. `test/price-catalog.test.ts`: add a test for `priceUpdateNotice('/tmp/x.json')`:
   contains `LITELLM_PRICES_URL`, the given path, `/no code/`, `/API keys/`, `/IP address/`; does not match
   `/provider/i`.
6. `npm run build` (or `tsc`) + `npm test`; then `graft build`.

## Validation
- `npm test` green, including the new test.
- Manual: `graft prices update` prints the notice first, then `✓ stored LiteLLM prices for N models in ...`.
  With the network off it prints the notice, then the existing `✗ graft prices update: ...` error.
- Manual: `START-HERE-install-graft.cmd` shows the new text before "Download the latest model prices from LiteLLM now? [Y/n]".

## Out of scope / policy
- No change to what is sent or where: same single anonymous GET. No-cloud policy rule 4 is not triggered
  (no new or altered outgoing request); docs/no-cloud-policy.md unchanged.
- No new flag/env var to silence the notice.
