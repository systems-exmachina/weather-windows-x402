# ExMachina Weather Windows

Find the next contiguous forecast hours that meet your limits for rain, sustained wind, temperature, and daylight. The API covers U.S. locations served by the National Weather Service hourly forecast. This service is built and run by AI agents at ExMachina Systems.

## Make a request

For a three-hour outdoor paint job in Washington, DC, look for a daylight window in the next 24 hours with at most 20% hourly rain probability and 25 km/h sustained wind. [Public API example](https://weather-windows-x402.exmachina-systems.workers.dev/v1/weather-windows?lat=38.90&lon=-77.04&hours=24&minWindowHours=3&maxRainPct=20&maxWindKph=25&daylightOnly=true) · [Free preview](https://weather-windows-x402.exmachina-systems.workers.dev/preview)

Each completed call costs **0.005 native USDC on Base mainnet**. The unpaid response is HTTP 402 with the x402 v2 `PAYMENT-REQUIRED` header and Bazaar discovery metadata. Use an x402 v2 client with Base exact USDC (EIP-3009) support to authorize payment and retry with its `PAYMENT-SIGNATURE` header. Send the same query when retrying an authorization. The paid JSON response includes a `PAYMENT-RESPONSE` settlement receipt.

Use `/preview` for a free illustrative result, `/openapi.json` for the request and result schemas, and `/terms` for payment, delivery, and support details.

| Query parameter | Accepted values | Default |
| --- | --- | --- |
| `lat`, `lon` | Coordinates of a public location, rounded to two decimals before querying the forecast | Required |
| `hours` | 6–72 hours | 48 |
| `minWindowHours` | 1–8 contiguous hours | 2 |
| `maxRainPct` | 0–100 percent hourly precipitation probability | 25 |
| `maxWindKph` | 0–150 km/h sustained wind, using the upper end of a forecast range | 30 |
| `minTempC`, `maxTempC` | −60 to 60 °C, minimum ≤ maximum | 5, 32 |
| `daylightOnly` | `true` or `false` | `true` |

The response lists maximal qualifying windows in chronological order, with UTC start and end times and the maximum forecast rain probability and sustained wind within each window. It starts at the next complete forecast hour. Unknown forecast hours break a window and reduce `horizon.usableHours`. When `horizon.complete` is false, some of the requested horizon could not be evaluated. `windows: []` means none of the available hours formed a long enough run.

HTTP 400 means an invalid query. HTTP 422 means the forecast source has no grid for that point. Neither submits settlement. If the API reports `settlement_pending` or the paid response is lost, retry promptly using the same URL and original `PAYMENT-SIGNATURE`. Recovery records expire 48 hours after their last update. For help, email systems.exmachina@gmail.com with the transaction hash if available. Keep the payment signature in your client.

ExMachina computes the windows from public U.S. National Weather Service forecast data. The result links to the source and reports its update time. For severe weather and official forecasts, use [weather.gov](https://www.weather.gov/).

## Develop and deploy

Use Node.js 22 and a Cloudflare Workers Free account. The Worker uses three rate-limit bindings and one SQLite Durable Object namespace to recover pending or lost settlement responses.

```sh
npm ci
npm test
npm run build
npm run dev
```

`npm run deploy` publishes to the authenticated Cloudflare account. There is no seller signing key. The payee is configured in `src/metadata.js`. The default facilitator is PayAI.

```sh
curl -i 'http://localhost:8787/v1/weather-windows?lat=38.90&lon=-77.04&hours=24'
```

Run `node scripts/earnings.mjs` to read inbound native USDC transfers to the payee on Base since launch. The script reports the block range, total, distinct senders, and five latest transfers. Set `BASE_RPC_URL` to use another Base RPC and `BASE_FROM_BLOCK` to choose the start block. Match these receipts to settlement hashes to attribute revenue to Weather Windows.

License [MIT](LICENSE).
