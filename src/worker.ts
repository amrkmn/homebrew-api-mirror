import { Hono } from "hono";

const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;

  const key = new URL(c.req.url).pathname.slice(1);
  const obj = await c.env.LARGE_ASSETS.get(key);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  if (obj.size) headers.set("content-length", String(obj.size));

  return new Response(obj.body, { headers });
});

export default app;
