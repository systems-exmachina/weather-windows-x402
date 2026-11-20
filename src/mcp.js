import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export async function handleMcp(request, getPreview) {
  // This stateless server has no event stream and performs no paid operations.
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  const server = new McpServer({ name: "weather-windows", version: "0.2.0" });
  server.registerTool("preview_weather", {
    title: "Preview Weather Windows and Hourly Forecast",
    description: "Get a free sample of outdoor weather windows for Washington, DC and hourly weather for Tokyo. Includes live or illustrative status and links to the x402 API for other coordinates.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => {
    const { weatherWindows, hourlyForecast, docs } = await getPreview();
    const result = { weatherWindows, hourlyForecast, docs };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
