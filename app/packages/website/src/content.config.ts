import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    sidebar_order: z.number().optional(),
  }),
});

// Posts are flat files: the filename is the slug (`/blog/<slug>`). `date` is a
// plain `YYYY-MM-DD`, read as UTC midnight and displayed in UTC so a post never
// shows the day before it was published to a reader west of Greenwich.
const blog = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    author: z.string().optional(),
    // Drafts render under `astro dev` and are left out of production builds.
    draft: z.boolean().optional(),
  }),
});

export const collections = { docs, blog };
