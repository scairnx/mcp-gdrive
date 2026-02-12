import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

/**
 * Register all MCP request handlers on the server
 * @param server The MCP server instance
 * @param authProvider Function that returns OAuth2Client for the current request (for multi-user)
 */
export function registerHandlers(
  server: Server,
  authProvider?: () => OAuth2Client | Promise<OAuth2Client>
) {
  /**
   * Get the auth client for the current request
   */
  async function getAuth(): Promise<any> {
    if (authProvider) {
      return await authProvider();
    }
    // Fall back to global auth (backward compatibility)
    const globalAuth = google._options?.auth;
    if (!globalAuth) {
      throw new Error("No authentication configured");
    }
    return globalAuth;
  }

  // List resources handler - paginated listing of Google Drive files
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const auth = await getAuth();
    const drive = google.drive({ version: "v3", auth });

    const pageSize = 10;
    const params: any = {
      pageSize,
      fields: "nextPageToken, files(id, name, mimeType)",
    };

    if (request.params?.cursor) {
      params.pageToken = request.params.cursor;
    }

    const res = await drive.files.list(params);
    const files = res.data.files || [];

    return {
      resources: files.map((file: any) => ({
        uri: `gdrive:///${file.id}`,
        mimeType: file.mimeType,
        name: file.name,
      })),
      nextCursor: res.data.nextPageToken,
    };
  });

  // Read resource handler - retrieve file content with automatic format conversion
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const auth = await getAuth();
    const drive = google.drive({ version: "v3", auth });

    const fileId = request.params.uri.replace("gdrive:///", "");

    // First get file metadata to check mime type
    const file = await drive.files.get({
      fileId,
      fields: "mimeType",
    });

    // For Google Docs/Sheets/etc we need to export
    if (file.data.mimeType?.startsWith("application/vnd.google-apps")) {
      let exportMimeType: string;
      switch (file.data.mimeType) {
        case "application/vnd.google-apps.document":
          exportMimeType = "text/markdown";
          break;
        case "application/vnd.google-apps.spreadsheet":
          exportMimeType = "text/csv";
          break;
        case "application/vnd.google-apps.presentation":
          exportMimeType = "text/plain";
          break;
        case "application/vnd.google-apps.drawing":
          exportMimeType = "image/png";
          break;
        default:
          exportMimeType = "text/plain";
      }

      const res = await drive.files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: "text" },
      );

      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: exportMimeType,
            text: res.data,
          },
        ],
      };
    }

    // For regular files download content
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    const mimeType = file.data.mimeType || "application/octet-stream";
    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: mimeType,
            text: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
          },
        ],
      };
    } else {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: mimeType,
            blob: Buffer.from(res.data as ArrayBuffer).toString("base64"),
          },
        ],
      };
    }
  });

  // List tools handler - expose the search tool
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "search",
          description: "Search for files in Google Drive",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query",
              },
            },
            required: ["query"],
          },
        },
      ],
    };
  });

  // Call tool handler - execute the search tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search") {
      const auth = await getAuth();
      const drive = google.drive({ version: "v3", auth });

      const userQuery = request.params.arguments?.query as string;
      const escapedQuery = userQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const formattedQuery = `fullText contains '${escapedQuery}'`;

      const res = await drive.files.list({
        q: formattedQuery,
        pageSize: 10,
        fields: "files(id, name, mimeType, modifiedTime, size)",
      });

      const fileList = res.data.files
        ?.map((file: any) => `${file.name} (${file.mimeType})`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Found ${res.data.files?.length ?? 0} files:\n${fileList}`,
          },
        ],
        isError: false,
      };
    }
    throw new Error("Tool not found");
  });
}
