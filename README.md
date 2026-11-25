# Shorts Generator

Pipeline: yt-dlp download → ffmpeg audio → OpenAI Whisper (word timestamps) → Claude picks 5–6 moments + hooks → ffmpeg crops to 9:16 and burns captions → MP4s served with preview + download.

## Deploy (Render / Railway / any Docker host)
1. Push this folder to a Git repo, create a Docker web service.
2. Set env vars from `.env.example` (OPENAI_API_KEY, ANTHROPIC_API_KEY).
3. Attach a persistent disk/volume mounted at `/data`.
4. Use at least 2 vCPU / 4 GB RAM; rendering is CPU-bound.

## Scaling
Jobs run in-process (MAX_CONCURRENT_JOBS). To scale out, move `process_()` into a worker
behind Redis/BullMQ and store outputs in S3/R2 with signed URLs; the API shape stays the same.

## Notes
- Only process videos you own or have permission to use; the app requires confirmation. Downloading others' videos can violate YouTube's Terms.
- YouTube may block datacenter IPs; if downloads fail, supply cookies via YTDLP_COOKIES.
- Captions are centered-crop 9:16; hook text shows for the first 3 seconds.
