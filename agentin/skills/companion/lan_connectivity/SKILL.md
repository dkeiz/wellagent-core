# Companion LAN / Wi-Fi Connectivity

Use this skill when a phone or another device must connect to the LocalAgent companion server running on this PC.

## Requirements

- The PC and phone must be on the same Wi-Fi/LAN network.
- The companion server should bind to `0.0.0.0`.
- Default companion port is `8790`.
- Guest Wi-Fi, router AP isolation, VPN software, or a Public firewall profile can block device-to-device access.

## Check Server Binding

Run on the PC:

```powershell
netstat -ano -p tcp | Select-String -Pattern ':8790.*LISTENING'
```

Expected:

```text
TCP    0.0.0.0:8790    0.0.0.0:0    LISTENING
```

If it shows `127.0.0.1:8790`, phones cannot connect. Set companion host to `0.0.0.0` and restart/apply companion access.

## Find The PC Address

Run:

```powershell
ipconfig
```

Use the IPv4 address from the active Wi-Fi or Ethernet adapter, for example:

```text
192.168.31.128
```

Open this from the phone:

```text
http://<pc-ip>:8790/companion/web
```

Example:

```text
http://192.168.31.128:8790/companion/web
```

## Allow Windows Firewall

Run from an elevated terminal:

```powershell
netsh advfirewall firewall add rule name="LocalAgent Companion 8790" dir=in action=allow protocol=TCP localport=8790 profile=private,domain
```

Verify:

```powershell
netsh advfirewall firewall show rule name="LocalAgent Companion 8790"
```

## Verify From The PC

Run:

```powershell
curl.exe --noproxy "*" http://<pc-ip>:8790/companion/health
```

Expected response contains:

```json
{"ok":true,"kind":"companion"}
```

If this works on the PC but not from the phone, the remaining blocker is usually router isolation, guest Wi-Fi, phone VPN/proxy, or Windows network profile/firewall policy.
