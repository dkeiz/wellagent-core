# LocalAgent Remote Gateway

Self-hosted relay for companion access when the desktop is not reachable on LAN.

## Run

```sh
export REMOTE_GATEWAY_SECRET="replace-with-a-long-random-secret"
export REMOTE_GATEWAY_PORT=8791
node server.js
```

The desktop app connects to:

```text
wss://your-domain.example/gateway/host
```

For a plain test without TLS:

```text
ws://your-vps-ip:8791/gateway/host
```

## Reverse Proxy

Use Caddy, nginx, or another TLS proxy in front of this process for public use.
Forward WebSocket upgrades and normal HTTP traffic to the Node process.

## Protocol

- Desktop host connects to `/gateway/host` with `Authorization: Bearer <secret>`.
- Remote companion HTTP requests under `/companion/*` are wrapped and sent to the host. Protected companion routes still require normal companion access tokens.
- Remote companion WebSocket `/companion/ws` is accepted by the gateway, then authorized by the desktop using the normal companion ticket flow.
- The gateway does not process LLM traffic or store messages. It only forwards frames while the desktop host is connected.

## Docker

```sh
docker build -t localagent-remote-gateway .
docker run -p 8791:8791 -e REMOTE_GATEWAY_SECRET="replace-me" localagent-remote-gateway
```
