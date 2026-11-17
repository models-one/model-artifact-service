import { z } from "zod";
import { renderRequestSchema, runRequestSchema } from "./schema";

const errorResponse = {
  description:
    "Failure with a stable code, stage, request id and redacted diagnostic details",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
};
const runResponse = {
  description:
    "Task and any generated artifacts; failed tasks retain partial outputs",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Run" } },
  },
};

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Model Artifact Service",
    version: "0.1.0",
    description:
      "Caller-triggered SVG generation. No schedules, scoring, or automatic upstream retries.",
  },
  security: [{ serviceToken: [] }],
  paths: {
    "/v1/capabilities": {
      get: {
        responses: {
          "200": {
            description: "Client render permission and retention policy",
          },
          "401": errorResponse,
        },
      },
    },
    "/v1/renders": {
      post: {
        operationId: "createRender",
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: { type: "string", maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: z.toJSONSchema(renderRequestSchema, { io: "input" }),
            },
          },
        },
        responses: {
          "202": runResponse,
          "401": errorResponse,
          "403": errorResponse,
          "409": errorResponse,
          "410": errorResponse,
          "422": errorResponse,
          "429": errorResponse,
        },
      },
    },
    "/healthz": {
      get: {
        security: [],
        responses: { "200": { description: "Service is running" } },
      },
    },
    "/v1/runs": {
      post: {
        operationId: "createRun",
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            schema: { type: "string", maxLength: 200 },
            description:
              "Scoped to the caller; replays return the original task. A changed body returns 409.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: z.toJSONSchema(runRequestSchema, { io: "input" }),
            },
          },
        },
        responses: {
          "202": runResponse,
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "409": errorResponse,
          "413": errorResponse,
          "415": errorResponse,
          "422": errorResponse,
          "429": errorResponse,
          "500": errorResponse,
        },
      },
      get: {
        operationId: "listRuns",
        parameters: [
          { in: "query", name: "model", schema: { type: "string" } },
          {
            in: "query",
            name: "status",
            schema: {
              type: "string",
              enum: ["queued", "running", "succeeded", "failed"],
            },
          },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          {
            in: "query",
            name: "offset",
            schema: {
              type: "integer",
              minimum: 0,
              maximum: 1000000,
              default: 0,
            },
          },
        ],
        responses: {
          "200": {
            description: "Caller-owned task history",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Run" },
                    },
                    limit: { type: "integer" },
                    offset: { type: "integer" },
                  },
                },
              },
            },
          },
          "401": errorResponse,
          "422": errorResponse,
        },
      },
    },
    "/v1/runs/{id}": {
      get: {
        operationId: "getRun",
        parameters: [
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": runResponse,
          "401": errorResponse,
          "404": errorResponse,
        },
      },
    },
    "/v1/artifacts/{id}": {
      get: {
        operationId: "getArtifact",
        parameters: [
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description:
              "Authenticated artifact. SVG and text use attachment disposition; PNG can be displayed.",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
              "image/svg+xml": {
                schema: { type: "string", format: "binary" },
              },
              "text/plain": { schema: { type: "string" } },
            },
          },
          "401": errorResponse,
          "404": errorResponse,
          "500": errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: { serviceToken: { type: "http", scheme: "bearer" } },
    schemas: {
      Error: {
        type: "object",
        required: ["error", "request_id"],
        properties: {
          request_id: { type: "string" },
          error: { $ref: "#/components/schemas/Diagnostic" },
        },
      },
      Diagnostic: {
        type: "object",
        required: ["code", "stage", "message"],
        properties: {
          code: { type: "string" },
          stage: { type: "string" },
          message: { type: "string" },
          details: { type: "object", additionalProperties: true },
          causes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                message: { type: "string" },
                code: { type: "string" },
                stack: { type: "string" },
              },
            },
          },
        },
      },
      Run: {
        type: "object",
        required: ["id", "status", "request", "artifacts", "created_at"],
        properties: {
          id: { type: "string" },
          status: {
            type: "string",
            enum: ["queued", "running", "succeeded", "failed"],
          },
          stage: { type: "string" },
          request: {
            type: "object",
            description:
              "Generation inputs; provided-output tasks have no upstream connection",
            additionalProperties: true,
          },
          source: { type: "string", enum: ["provided"] },
          collection_key: { type: "string" },
          generated_at: { type: "string", format: "date-time" },
          expires_at: {
            type: "integer",
            description: "Unix epoch milliseconds",
          },
          connection: { type: "object", additionalProperties: true },
          prompt_sha256: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          started_at: { type: "string", format: "date-time" },
          finished_at: { type: "string", format: "date-time" },
          generation: { type: "object", additionalProperties: true },
          error: { $ref: "#/components/schemas/Diagnostic" },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "type", "path"],
              properties: {
                id: { type: "string" },
                type: { type: "string", enum: ["raw_text", "svg", "png"] },
                path: { type: "string" },
                size: { type: "integer" },
                sha256: { type: "string" },
                content_type: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};
