FROM node:20-alpine

# Instalar dependencias del sistema
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev

WORKDIR /app

# Copiar package files
COPY package*.json ./

# Instalar dependencias
RUN npm install --production

# Copiar código
COPY index.js ./

# Crear directorios para datos persistentes
RUN mkdir -p /app/auth_info /app/media

# Exponer puerto
EXPOSE 3000

# Variables de entorno por defecto
ENV NODE_ENV=production

# Comando de inicio
CMD ["node", "index.js"]
