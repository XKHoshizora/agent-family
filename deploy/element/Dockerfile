FROM vectorim/element-web:v1.12.35
COPY config.json /app/config.json
COPY af-home.html /app/af-home.html
COPY af-module.js af-module.css af-login.html af-login.js af-logout.html af-logout.js /app/
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY security-headers.conf /etc/nginx/af-security-headers.conf
ENV AF_BACKEND_URL=https://agent-family-web-production.up.railway.app
ENV ELEMENT_WEB_PORT=8080
