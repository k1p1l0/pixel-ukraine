// Local image-generation proxy to Cloudflare Workers AI, for free-art.py. Run it only with `wrangler dev` (it listens on
// localhost and uses your logged-in wrangler account); never deploy it, it has no auth.
//   POST /gen { model: 'schnell' | 'klein', prompt, width?, height?, seed?, refs?: [base64 PNG, ...] } -> { image: base64, neurons }
// Workers AI free allocation: 10,000 neurons a day (checked 2026-10-14). flux-1-schnell: 4.8 per 512x512 tile + 9.6 per
// step, always 1024x1024 at 4 steps = 57.6. flux-2-klein-4b: 26.05 per output 512x512 tile + 5.37 per input tile, 4 steps fixed.
const b64bytes = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
const tiles = (w, h) => Math.ceil(w / 512) * Math.ceil(h / 512);
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method !== 'POST' || u.pathname !== '/gen') return new Response('POST /gen', { status: 404 });
    const j = await req.json();
    try {
      if (j.model === 'klein') {
        const w = j.width || 512, h = j.height || 512, form = new FormData();
        form.append('prompt', j.prompt); form.append('width', String(w)); form.append('height', String(h));
        if (j.seed != null) form.append('seed', String(j.seed));
        (j.refs || []).slice(0, 4).forEach((r, i) => form.append(`input_image_${i}`, new Blob([b64bytes(r)], { type: 'image/png' }), `ref${i}.png`));
        const body = new Response(form), out = await env.AI.run('@cf/black-forest-labs/flux-2-klein-4b', { multipart: { body: body.body, contentType: body.headers.get('content-type') } });
        return Response.json({ image: out.image, neurons: +(tiles(w, h) * 26.05 + (j.refs || []).length * 5.37).toFixed(2) });
      }
      const out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt: j.prompt, steps: 4 });
      return Response.json({ image: out.image, neurons: 57.6 });
    } catch (e) { return Response.json({ error: String(e && e.message || e) }, { status: 500 }); }
  },
};
