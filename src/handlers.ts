import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { Readable } from "stream";

// Scope required for write operations
const WRITE_SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * Register all MCP request handlers on the server
 */
export function registerHandlers(
  server: Server,
  authProvider?: () => OAuth2Client | Promise<OAuth2Client>
) {
  async function getAuth(): Promise<any> {
    if (authProvider) {
      return await authProvider();
    }
    const globalAuth = google._options?.auth;
    if (!globalAuth) throw new Error("No authentication configured");
    return globalAuth;
  }

  /** Check if the auth client has write scope */
  async function hasWriteAccess(auth: OAuth2Client): Promise<boolean> {
    try {
      const token = auth.credentials?.access_token;
      if (!token) return false;
      const info = await auth.getTokenInfo(token);
      return !!info.scopes?.includes(WRITE_SCOPE);
    } catch {
      return false;
    }
  }

  /**
   * Read a file's content and return it as a string.
   * Handles Google Workspace exports and binary files.
   */
  async function readFileContent(drive: any, fileId: string): Promise<{ content: string; mimeType: string; name: string }> {
    const file = await drive.files.get({
      fileId,
      fields: "mimeType, name",
    });

    const mimeType = file.data.mimeType || "application/octet-stream";
    const name = file.data.name || fileId;

    if (mimeType.startsWith("application/vnd.google-apps")) {
      let exportMimeType: string;
      switch (mimeType) {
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
        { responseType: "text" }
      );
      return { content: String(res.data), mimeType: exportMimeType, name };
    }

    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );

    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      return {
        content: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
        mimeType,
        name
      };
    }

    return {
      content: Buffer.from(res.data as ArrayBuffer).toString("base64"),
      mimeType,
      name
    };
  }

  // =========================================================================
  // RESOURCES (legacy MCP resource interface)
  // =========================================================================

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

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const auth = await getAuth();
    const drive = google.drive({ version: "v3", auth });

    const fileId = request.params.uri.replace("gdrive:///", "");
    const { content, mimeType } = await readFileContent(drive, fileId);

    if (mimeType === "image/png") {
      return {
        contents: [{ uri: request.params.uri, mimeType, blob: content }],
      };
    }

    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      return {
        contents: [{ uri: request.params.uri, mimeType, text: content }],
      };
    }

    // Base64 blob
    return {
      contents: [{ uri: request.params.uri, mimeType, blob: content }],
    };
  });

  // =========================================================================
  // TOOLS
  // =========================================================================

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // ── Search ───────────────────────────────────────────────────────────
        {
          name: "search",
          description: "Search for files in Google Drive by content or name",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query (full-text search)" },
            },
            required: ["query"],
          },
        },

        // ── List ─────────────────────────────────────────────────────────────
        {
          name: "list_files",
          description: "List files and folders in Google Drive. Optionally filter by folder, file type, or custom query.",
          inputSchema: {
            type: "object",
            properties: {
              folder_id: { type: "string", description: "Folder ID to list contents of (omit for all files)" },
              query: { type: "string", description: "Additional Drive query filter (e.g. \"mimeType='text/plain'\")" },
              page_size: { type: "number", description: "Number of results (default 20, max 100)" },
              page_token: { type: "string", description: "Page token for pagination (from previous response)" },
              order_by: { type: "string", description: "Sort order (e.g. 'modifiedTime desc', 'name')" },
            },
          },
        },

        // ── Read ─────────────────────────────────────────────────────────────
        {
          name: "read_file",
          description: "Read the content of a file by its ID. Google Docs → Markdown, Sheets → CSV, Slides → text.",
          inputSchema: {
            type: "object",
            properties: {
              file_id: { type: "string", description: "Google Drive file ID" },
            },
            required: ["file_id"],
          },
        },

        // ── Get info ──────────────────────────────────────────────────────────
        {
          name: "get_file_info",
          description: "Get metadata about a file: name, type, size, dates, owner, sharing status, and web link.",
          inputSchema: {
            type: "object",
            properties: {
              file_id: { type: "string", description: "Google Drive file ID" },
            },
            required: ["file_id"],
          },
        },

        // ── Create file ───────────────────────────────────────────────────────
        {
          name: "create_file",
          description: "Create a new file in Google Drive with text content.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "File name (including extension, e.g. 'notes.txt')" },
              content: { type: "string", description: "File content (text)" },
              folder_id: { type: "string", description: "Parent folder ID (omit to create in root)" },
              mime_type: { type: "string", description: "MIME type (default: text/plain). Use 'application/vnd.google-apps.document' for Google Docs." },
            },
            required: ["name", "content"],
          },
        },

        // ── Update file ───────────────────────────────────────────────────────
        {
          name: "update_file",
          description: "Update an existing file's content and/or rename it.",
          inputSchema: {
            type: "object",
            properties: {
              file_id: { type: "string", description: "Google Drive file ID" },
              content: { type: "string", description: "New file content (omit to keep existing content)" },
              name: { type: "string", description: "New file name (omit to keep existing name)" },
            },
            required: ["file_id"],
          },
        },

        // ── Delete file ───────────────────────────────────────────────────────
        {
          name: "delete_file",
          description: "Move a file or folder to the trash in Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              file_id: { type: "string", description: "Google Drive file ID" },
              permanently: { type: "boolean", description: "Permanently delete instead of moving to trash (default: false)" },
            },
            required: ["file_id"],
          },
        },

        // ── Create folder ─────────────────────────────────────────────────────
        {
          name: "create_folder",
          description: "Create a new folder in Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Folder name" },
              parent_id: { type: "string", description: "Parent folder ID (omit to create in root)" },
            },
            required: ["name"],
          },
        },

        // ── Move file ─────────────────────────────────────────────────────────
        {
          name: "move_file",
          description: "Move a file or folder to a different folder.",
          inputSchema: {
            type: "object",
            properties: {
              file_id: { type: "string", description: "Google Drive file ID to move" },
              folder_id: { type: "string", description: "Destination folder ID" },
            },
            required: ["file_id", "folder_id"],
          },
        },

        // ── Copy file ─────────────────────────────────────────────────────────
        {
          name: "copy_file",
          description: "Make a copy of a file in Google Drive.",
          inputSchema: {
            type: "object",
            properties: {
              file_id: { type: "string", description: "Google Drive file ID to copy" },
              name: { type: "string", description: "Name for the copy (default: 'Copy of <original name>')" },
              folder_id: { type: "string", description: "Destination folder ID (default: same folder as original)" },
            },
            required: ["file_id"],
          },
        },

        // ── Share file ────────────────────────────────────────────────────────
        {
          name: "share_file",
          description: "Share a file or folder with another user by email.",
          inputSchema: {
            type: "object",
            properties: {
              file_id: { type: "string", description: "Google Drive file ID" },
              email: { type: "string", description: "Email address to share with" },
              role: {
                type: "string",
                description: "Permission role: 'reader' (view), 'commenter' (comment), 'writer' (edit). Default: reader",
                enum: ["reader", "commenter", "writer"],
              },
              send_notification: { type: "boolean", description: "Send email notification to the recipient (default: true)" },
            },
            required: ["file_id", "email"],
          },
        },
      ],
    };
  });

  // =========================================================================
  // TOOL HANDLERS
  // =========================================================================

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const auth = await getAuth();
    const drive = google.drive({ version: "v3", auth });
    const args = request.params.arguments as any;

    const text = (s: string) => ({ content: [{ type: "text", text: s }], isError: false });
    const err = (s: string) => ({ content: [{ type: "text", text: `Error: ${s}` }], isError: true });

    switch (request.params.name) {

      // ── search ─────────────────────────────────────────────────────────────
      case "search": {
        const userQuery = args?.query as string;
        const escaped = userQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const res = await drive.files.list({
          q: `fullText contains '${escaped}'`,
          pageSize: 10,
          fields: "files(id, name, mimeType, modifiedTime, size)",
        });
        const files = res.data.files || [];
        const fileList = files
          .map((f: any) => `${f.name} (${f.mimeType}) [ID: ${f.id}]`)
          .join("\n");
        return text(`Found ${files.length} files:\n${fileList}`);
      }

      // ── list_files ─────────────────────────────────────────────────────────
      case "list_files": {
        const pageSize = Math.min(args?.page_size || 20, 100);
        const params: any = {
          pageSize,
          fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size, parents, trashed)",
          orderBy: args?.order_by || "modifiedTime desc",
        };

        const queryParts: string[] = [];
        if (args?.folder_id) queryParts.push(`'${args.folder_id}' in parents`);
        if (args?.query) queryParts.push(args.query);
        if (queryParts.length) params.q = queryParts.join(" and ");
        if (args?.page_token) params.pageToken = args.page_token;

        const res = await drive.files.list(params);
        const files = res.data.files || [];

        const lines = files.map((f: any) => {
          const size = f.size ? ` (${Math.round(f.size / 1024)}KB)` : "";
          const modified = f.modifiedTime ? ` [modified: ${f.modifiedTime.split("T")[0]}]` : "";
          return `• ${f.name}${size}${modified}\n  ID: ${f.id}\n  Type: ${f.mimeType}`;
        });

        let result = `${files.length} file(s) found:\n\n${lines.join("\n\n")}`;
        if (res.data.nextPageToken) {
          result += `\n\nMore results available. Use page_token: "${res.data.nextPageToken}"`;
        }
        return text(result);
      }

      // ── read_file ──────────────────────────────────────────────────────────
      case "read_file": {
        if (!args?.file_id) return err("file_id is required");
        const { content, mimeType, name } = await readFileContent(drive, args.file_id);
        return text(`File: ${name}\nType: ${mimeType}\n\n${content}`);
      }

      // ── get_file_info ──────────────────────────────────────────────────────
      case "get_file_info": {
        if (!args?.file_id) return err("file_id is required");
        const res = await drive.files.get({
          fileId: args.file_id,
          fields: "id, name, mimeType, size, modifiedTime, createdTime, owners, parents, webViewLink, webContentLink, shared, trashed, description",
        });
        const f = res.data;
        const info = [
          `Name: ${f.name}`,
          `ID: ${f.id}`,
          `Type: ${f.mimeType}`,
          f.size ? `Size: ${Math.round(Number(f.size) / 1024)}KB (${f.size} bytes)` : null,
          `Created: ${f.createdTime}`,
          `Modified: ${f.modifiedTime}`,
          f.owners?.length ? `Owner: ${f.owners.map((o: any) => o.emailAddress).join(", ")}` : null,
          `Shared: ${f.shared ? "Yes" : "No"}`,
          `Trashed: ${f.trashed ? "Yes" : "No"}`,
          f.description ? `Description: ${f.description}` : null,
          f.webViewLink ? `View: ${f.webViewLink}` : null,
          f.parents?.length ? `Parent folders: ${f.parents.join(", ")}` : null,
        ].filter(Boolean).join("\n");
        return text(info);
      }

      // ── create_file ────────────────────────────────────────────────────────
      case "create_file": {
        if (!args?.name) return err("name is required");
        if (!args?.content && args?.content !== "") return err("content is required");

        if (!(await hasWriteAccess(auth))) {
          return err("Write access required. Please re-authenticate at /oauth/authorize to grant Google Drive write permissions.");
        }

        const mimeType = args?.mime_type || "text/plain";
        const metadata: any = { name: args.name };
        if (args?.folder_id) metadata.parents = [args.folder_id];

        const res = await drive.files.create({
          requestBody: metadata,
          media: {
            mimeType,
            body: Readable.from([args.content]),
          },
          fields: "id, name, webViewLink",
        });

        return text(`File created successfully!\nName: ${res.data.name}\nID: ${res.data.id}\nLink: ${res.data.webViewLink}`);
      }

      // ── update_file ────────────────────────────────────────────────────────
      case "update_file": {
        if (!args?.file_id) return err("file_id is required");
        if (!args?.content && !args?.name) return err("At least one of content or name is required");

        if (!(await hasWriteAccess(auth))) {
          return err("Write access required. Please re-authenticate at /oauth/authorize to grant Google Drive write permissions.");
        }

        const params: any = {
          fileId: args.file_id,
          fields: "id, name",
        };

        if (args?.name) params.requestBody = { name: args.name };

        if (args?.content !== undefined) {
          // Get current mime type to preserve it
          const current = await drive.files.get({ fileId: args.file_id, fields: "mimeType" });
          const mimeType = current.data.mimeType?.startsWith("application/vnd.google-apps")
            ? "text/plain"
            : (current.data.mimeType || "text/plain");

          params.media = {
            mimeType,
            body: Readable.from([args.content]),
          };
        }

        const res = await drive.files.update(params);
        return text(`File updated successfully!\nName: ${res.data.name}\nID: ${res.data.id}`);
      }

      // ── delete_file ────────────────────────────────────────────────────────
      case "delete_file": {
        if (!args?.file_id) return err("file_id is required");

        if (!(await hasWriteAccess(auth))) {
          return err("Write access required. Please re-authenticate at /oauth/authorize to grant Google Drive write permissions.");
        }

        if (args?.permanently) {
          await drive.files.delete({ fileId: args.file_id });
          return text(`File permanently deleted (ID: ${args.file_id})`);
        } else {
          await drive.files.update({
            fileId: args.file_id,
            requestBody: { trashed: true },
          });
          return text(`File moved to trash (ID: ${args.file_id}). You can restore it from Google Drive trash.`);
        }
      }

      // ── create_folder ──────────────────────────────────────────────────────
      case "create_folder": {
        if (!args?.name) return err("name is required");

        if (!(await hasWriteAccess(auth))) {
          return err("Write access required. Please re-authenticate at /oauth/authorize to grant Google Drive write permissions.");
        }

        const metadata: any = {
          name: args.name,
          mimeType: "application/vnd.google-apps.folder",
        };
        if (args?.parent_id) metadata.parents = [args.parent_id];

        const res = await drive.files.create({
          requestBody: metadata,
          fields: "id, name, webViewLink",
        });

        return text(`Folder created successfully!\nName: ${res.data.name}\nID: ${res.data.id}\nLink: ${res.data.webViewLink}`);
      }

      // ── move_file ──────────────────────────────────────────────────────────
      case "move_file": {
        if (!args?.file_id) return err("file_id is required");
        if (!args?.folder_id) return err("folder_id is required");

        if (!(await hasWriteAccess(auth))) {
          return err("Write access required. Please re-authenticate at /oauth/authorize to grant Google Drive write permissions.");
        }

        // Get current parents to remove
        const current = await drive.files.get({ fileId: args.file_id, fields: "parents, name" });
        const previousParents = (current.data.parents || []).join(",");

        const res = await drive.files.update({
          fileId: args.file_id,
          addParents: args.folder_id,
          removeParents: previousParents,
          fields: "id, name, parents",
        });

        return text(`File moved successfully!\nName: ${res.data.name}\nID: ${res.data.id}\nNew parent folder ID: ${args.folder_id}`);
      }

      // ── copy_file ──────────────────────────────────────────────────────────
      case "copy_file": {
        if (!args?.file_id) return err("file_id is required");

        if (!(await hasWriteAccess(auth))) {
          return err("Write access required. Please re-authenticate at /oauth/authorize to grant Google Drive write permissions.");
        }

        const metadata: any = {};
        if (args?.name) metadata.name = args.name;
        if (args?.folder_id) metadata.parents = [args.folder_id];

        const res = await drive.files.copy({
          fileId: args.file_id,
          requestBody: metadata,
          fields: "id, name, webViewLink",
        });

        return text(`File copied successfully!\nName: ${res.data.name}\nID: ${res.data.id}\nLink: ${res.data.webViewLink}`);
      }

      // ── share_file ─────────────────────────────────────────────────────────
      case "share_file": {
        if (!args?.file_id) return err("file_id is required");
        if (!args?.email) return err("email is required");

        if (!(await hasWriteAccess(auth))) {
          return err("Write access required. Please re-authenticate at /oauth/authorize to grant Google Drive write permissions.");
        }

        const role = args?.role || "reader";
        const sendNotification = args?.send_notification !== false;

        await drive.permissions.create({
          fileId: args.file_id,
          sendNotificationEmail: sendNotification,
          requestBody: {
            type: "user",
            role,
            emailAddress: args.email,
          },
        });

        return text(`File shared successfully!\nShared with: ${args.email}\nPermission: ${role}\nNotification sent: ${sendNotification}`);
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  });
}
