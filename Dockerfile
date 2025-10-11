# --------- 生产密钥对 ---------
FROM python:3.10-slim AS builder-key

RUN pip config set global.index-url http://mirrors.cloud.tencent.com/pypi/simple \
    && pip config set global.trusted-host mirrors.cloud.tencent.com \
    && pip install --upgrade pip \
    && pip install --user pycryptodome --default-timeout=100

WORKDIR /app

COPY . .

RUN mkdir ./Client/assets/keys \
    && mkdir ./Web/public/keys \
    && python3 ./Tools/genKey.py

# --------- 构建前端 ---------
FROM node:lts-alpine AS builder-frontend

ENV TZ=Asia/Shanghai

RUN apk add --no-cache tzdata git curl \
	&& cp /usr/share/zoneinfo/$TZ /etc/localtime \
	&& echo $TZ > /etc/timezone

WORKDIR /app

COPY ./Web/package.json ./

RUN npm config set registry https://mirrors.huaweicloud.com/repository/npm/ \
    && npm config set strict-ssl false \
	&& npm install

COPY ./Web .   
COPY --from=builder-key /app/Web/public /app/public 

RUN sed -i 's#https://api\.xbt\.example\.com#/api#g' ./src/config.example.js \
    && mv ./src/config.example.js ./src/config.js \
    && npm run build

# --------- 构建后端 ---------
FROM python:3.10-slim AS builder-backend

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx tzdata ca-certificates curl build-essential \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./Server/requirements.txt /app/requirements.txt

RUN pip config set global.index-url http://mirrors.cloud.tencent.com/pypi/simple \
    && pip config set global.trusted-host mirrors.cloud.tencent.com \
    && pip install --upgrade pip \
    && pip install --user -r requirements.txt --default-timeout=100

COPY ./Server /app
COPY --from=builder-key /app/Server/keys /app/keys 

# --------- 运行环境 ---------
FROM python:3.10-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx \
    && echo Asia/Shanghai > /etc/timezone \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./Server /app
COPY ./nginx.conf /app/nginx.conf

COPY --from=builder-frontend /app/dist /app/static
COPY --from=builder-backend /root/.local /root/.local
COPY --from=builder-backend /etc/timezone /etc/timezone
COPY --from=builder-key /app/Server/keys /app/keys

EXPOSE 1314

CMD ["sh", "-c", "nginx -c /app/nginx.conf -g 'daemon on;' && python3 index.py"]