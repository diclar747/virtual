# Desplegar en Dokploy

Crear una aplicación con este repositorio:

- Repositorio: `https://github.com/diclar747/virtual.git`
- Rama: `main`
- Tipo de build: `Dockerfile`
- Archivo: `Dockerfile`
- Contexto de build: raíz del repositorio (`.`)
- Puerto del contenedor para el dominio: `4173`

En **Environment**, cargar estas variables con las claves reales del administrador:

```dotenv
PORT=4173
NIRO_API_BASE=https://niro.cnid.com.py/api/v1
NIRO_API_KEY=REEMPLAZAR
ROUTER_API_BASE=https://router.cnid.com.py/v1
ROUTER_API_KEY=REEMPLAZAR
ROUTER_CHAT_MODEL=cx/gpt-5.6-luna
ROUTER_TTS_MODEL=edge-tts/es-PY-TaniaNeural
```

Las claves no se incluyen en Git ni en la imagen Docker. Configurarlas como variables de ejecución, no como argumentos de construcción.

Agregar un dominio con HTTPS y desplegar. HTTPS es necesario para que el navegador permita usar el micrófono fuera de localhost. La aplicación escucha en todas las interfaces del contenedor y no necesita un paso de instalación o compilación: usa Node.js sin dependencias externas.

Verificar que `/api/health` responda y muestre `chatProvider: router` y `voiceProvider: router`. Después abrir la esfera, permitir el micrófono y probar una consulta y una interrupción. La calidad de voz y cancelación de eco requieren verificación con el dispositivo real.

El servidor Linux debe tener salida HTTPS hacia Niro y el router. Si se omite `ROUTER_TTS_MODEL`, el fallback de Windows no está disponible en Linux. Mantener configurado el proveedor de voz del router.

Este repositorio prepara el despliegue; no contiene la configuración de acceso al servidor ni realiza el despliegue automáticamente.

Referencia: https://docs.dokploy.com/docs/core/applications
