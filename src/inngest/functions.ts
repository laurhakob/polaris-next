import { generateText } from "ai";
import { inngest } from "./client";
import { firecrawl } from "@/lib/firecrawl";
import { google } from "@ai-sdk/google";

const URL_REGEX = /https?:\/\/[^\s]+/g;

export const demoGenerate = inngest.createFunction(
  { id: "demo-generate" },
  { event: "demo/generate" },
  async ({ event, step }) => {
    const { prompt } = event.data as { prompt: string };

    const urls = (await step.run("exctract-urls", async () => {
      return prompt.match(URL_REGEX) ?? [];
    })) as string[];

    // const scrapedContent = await step.run("scrape-urls", async () => {
    //   const results = await Promise.all(
    //     urls.map(async (url) => {
    //       const result = await firecrawl.scrapeUrl(url, {
    //         formats: ["markdown"],
    //       });
    //       return result.markdown ?? null;
    //     })
    //   );
    //   return results.filter(Boolean).join("\n\n");
    // });

    const scrapedContent = await step.run("scrape-urls", async () => {
      const results = await Promise.all(
        urls.map(async (url) => {
          const result = await firecrawl.scrapeUrl(url, {
            formats: ["markdown"],
          });

          // Check if the result is successful and has markdown
          if (result.success && "markdown" in result) {
            return result.markdown ?? null;
          }
          return null;
        })
      );
      return results.filter(Boolean).join("\n\n");
    });

    const finalPrompt = scrapedContent
      ? `Context:\n${scrapedContent}\n\nQuestion: ${prompt}`
      : prompt;

    await step.run("generate-text", async () => {
      return await generateText({
        model: google("gemini-2.5-flash-lite"),
        prompt: finalPrompt,
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: true,
          recordOutputs: true,
        },
      });
    });
  }
);

export const demoError = inngest.createFunction(
  { id: "demo-error" },
  { event: "demo/error" },
  async ({ step }) => {
    await step.run("fail", async () => {
      throw new Error("Inngest error: Background job failed!");
    });
  }
);


