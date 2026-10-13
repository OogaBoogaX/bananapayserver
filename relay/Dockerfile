# The relay: runs on a donating node's machine, in its own container, with no access to LND's
# files. Build from the repository root:
#
#   docker build -f relay/Dockerfile -t bananapayserver-relay .
#
# Publish no ports. The webhook listener is for BTCPay on the machine's internal network only.
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY shared/ shared/
COPY relay/*.mjs relay/
USER node
CMD ["node", "relay/main.mjs"]
