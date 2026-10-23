# The relay: runs on a donating node's machine, in its own container, with no access to LND's
# files. Build from the repository root:
#
#   docker build -f relay/Dockerfile -t bananapayserver-relay .
#
# Publish no ports. The webhook listener is for BTCPay on the machine's internal network only.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /app
COPY shared/ shared/
COPY relay/*.mjs relay/
USER node
CMD ["node", "relay/main.mjs"]
