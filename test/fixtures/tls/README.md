# TLS 测试证书

`localhost-key.pem` 是公开的测试私钥，仅用于本机测试，不能用于部署。配套自签名证书包含 `localhost` 和 `127.0.0.1`，测试客户端通过 `ca` 明确信任该证书，并保留主机名校验。

PEM 文件已经保存，运行测试无需 OpenSSL。需要重新生成时，在项目根目录执行：

```sh
openssl req -x509 -nodes -newkey rsa:2048 -days 36500 -config test/fixtures/tls/openssl.cnf -keyout test/fixtures/tls/localhost-key.pem -out test/fixtures/tls/localhost-cert.pem
```
