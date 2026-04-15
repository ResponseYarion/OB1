FROM denoland/deno:2.3.3

WORKDIR /app

COPY deno.json ./
COPY index.ts ./

RUN deno cache index.ts

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "index.ts"]
