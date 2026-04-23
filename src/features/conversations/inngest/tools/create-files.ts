import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

interface CreateFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const paramsSchema = z.object({
  parentId: z.string(),
  name: z.string().min(1, "File name cannot be empty"),
  content: z.string(),
});

export const createCreateFilesTool = ({
  projectId,
  internalKey,
}: CreateFilesToolOptions) => {
  return createTool({
    name: "createFile",
    description:
      "Create a single file in the project. Call this tool once per file you need to create. Use listFiles first to get valid folder IDs for parentId.",
    parameters: z.object({
      parentId: z
        .string()
        .describe(
          "The ID of the parent folder. Use empty string for root level. Must be a valid folder ID from listFiles."
        ),
      name: z.string().describe("The file name including extension"),
      content: z.string().describe("The file content"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { parentId, name, content } = parsed.data;

      try {
        return await toolStep?.run("create-file", async () => {
          let resolvedParentId: Id<"files"> | undefined;

          if (parentId && parentId !== "") {
            try {
              resolvedParentId = parentId as Id<"files">;
              const parentFolder = await convex.query(api.system.getFileById, {
                internalKey,
                fileId: resolvedParentId,
              });
              if (!parentFolder) {
                return `Error: Parent folder with ID "${parentId}" not found. Use listFiles to get valid folder IDs.`;
              }
              if (parentFolder.type !== "folder") {
                return `Error: The ID "${parentId}" is a file, not a folder. Use a folder ID as parentId.`;
              }
            } catch {
              return `Error: Invalid parentId "${parentId}". Use listFiles to get valid folder IDs, or use empty string for root level.`;
            }
          }

          const results = await convex.mutation(api.system.createFiles, {
            internalKey,
            projectId,
            parentId: resolvedParentId,
            files: [{ name, content }],
          });

          const result = results[0];

          if (result.error) {
            return `Failed to create "${result.name}": ${result.error}`;
          }

          return `Created file "${result.name}"`;
        });
      } catch (error) {
        return `Error creating file: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};
