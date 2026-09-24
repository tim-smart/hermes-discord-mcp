/** @effect-diagnostics nodeBuiltinImport:off */
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { DiscordConfig, DiscordREST, DiscordRESTLive, MemoryRateLimitStoreLive } from "dfx"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"

export class PostError extends Schema.TaggedError<PostError>()("PostError", {
  message: Schema.String
}) {}

const WebhookUrl = Schema.TemplateLiteralParser([
  "https://discord.com/api/webhooks/",
  Schema.String,
  "/",
  Schema.String
])

const PostToHermes = Tool.make("post_to_hermes", {
  description: "Post a message to the Hermes Discord channel",
  parameters: Schema.Struct({
    message: Schema.String.annotate({ description: "The message content to post" })
  }),
  success: Schema.Struct({ id: Schema.String }),
  failure: PostError,
  failureMode: "return"
})

const HermesToolkit = Toolkit.make(PostToHermes)

const HermesToolkitLayer = HermesToolkit.toLayer(Effect.gen(function*() {
  const rest = yield* DiscordREST
  const [, webhookId, , webhookToken] = yield* Config.schema(WebhookUrl, "DISCORD_WEBHOOK_URL")
  const botId = yield* Config.String("HERMES_BOT_ID")

  return HermesToolkit.of({
    post_to_hermes: Effect.fn("HermesToolkit.post_to_hermes")(
      function*({ message }) {
        const response = yield* rest.executeWebhook(webhookId, webhookToken, {
          params: { wait: true },
          payload: {
            content: `<@${botId}> ${message}`,
            allowed_mentions: { users: [botId] }
          }
        })
        return { id: response.id }
      },
      Effect.mapError((error) => new PostError({ message: String(error) }))
    )
  })
}))

// Webhook routes are authenticated by the URL, so the bot token is unused.
const DiscordLayer = DiscordRESTLive.pipe(
  Layer.provide([
    DiscordConfig.layer({ token: Redacted.make("unused") }),
    NodeHttpClient.layerUndici,
    MemoryRateLimitStoreLive
  ])
)

const digest = (value: string) => createHash("sha256").update(value).digest()

const BearerAuth = HttpRouter.middleware(
  Effect.gen(function*() {
    const expected = digest(`Bearer ${Redacted.value(yield* Config.Redacted("MCP_BEARER_TOKEN"))}`)
    return (httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        timingSafeEqual(digest(request.headers["authorization"] ?? ""), expected)
          ? httpEffect
          : Effect.succeed(HttpServerResponse.empty({ status: 401 })))
  }),
  { global: true }
)

const McpRoutes = McpServer.toolkit(HermesToolkit).pipe(
  Layer.provide(HermesToolkitLayer),
  Layer.provide(DiscordLayer),
  Layer.provide(McpServer.layerHttp({
    name: "hermes-discord-mcp",
    version: "1.0.0",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25, McpProtocol.v2025_06_18]
  }))
)

const Main = HttpRouter.serve(Layer.mergeAll(McpRoutes, BearerAuth)).pipe(
  Layer.provide(NodeHttpServer.layerConfig(createServer, {
    port: Config.Port("PORT").pipe(Config.withDefault(3000))
  }))
)

NodeRuntime.runMain(Layer.launch(Main))
