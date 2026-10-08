# Personal Paraguay · Asistente virtual

Asistente de conversación por voz con esfera animada, escucha continua e interrupciones. Usa Niro para transcripción y el router configurado para respuestas de ChatGPT y generación de voz.

Para desplegar en un servidor Linux con Dokploy, consultar [DOKPLOY.md](DOKPLOY.md). El proyecto incluye Dockerfile y no requiere dependencias npm. Las claves se cargan como variables privadas del servidor. El archivo `knowledge/personal-reference.md` conserva la base de conocimiento completa suministrada; `knowledge/personal-prompt.md` es el prompt resumido usado actualmente.

Configuración actual: Niro transcribe, el router responde con `cx/gpt-5.6-luna` y Edge TTS del mismo router genera la voz paraguaya `edge-tts/es-PY-TaniaNeural`. El audio se reproduce automáticamente desde la esfera, sin controles visibles. Esta voz se verificó con una respuesta MP3 real. La conversación sigue funcionando por turnos; no es una conexión de voz simultánea como GPT-Live.

La esfera mantiene el micrófono abierto y puede cortar la reproducción al detectar una nueva intervención. No muestra transcripciones. La voz se convierte internamente a WAV y se envía a Niro solamente después de detectar habla y una pausa; la transcripción sigue siendo necesaria porque el modelo conectado responde a texto. La detección de interrupciones se verificó con audio simulado; la cancelación de eco y la sensibilidad deben probarse con el micrófono y parlantes reales. Usar auriculares ayuda cuando los parlantes vuelven a entrar por el micrófono. La voz sigue siendo Edge TTS; para reemplazar su calidad y eliminar la cadena por turnos se necesita habilitar otro proveedor con audio en vivo.

## Ejecutar

1. Copiá `.env.example` como `.env.local`.
2. Completá `NIRO_API_KEY` con tu clave de Niro.
3. Abrí una terminal en esta carpeta y ejecutá `npm start`.
4. Visitá `http://localhost:4173`.

La clave se utiliza únicamente en `server.mjs`; nunca se envía al navegador. Para usar el micrófono, aceptá el permiso del navegador cuando toques la esfera o el botón de micrófono.

## Próximos pasos recomendados

Para activar la voz neuronal, agregá `OPENAI_API_KEY` y `OPENAI_TTS_VOICE=marin` al archivo privado `.env.local` y reiniciá el servidor. Se usa OpenAI únicamente para pronunciar el texto de la respuesta; Niro conserva el chat y la transcripción. Este uso tiene facturación separada en OpenAI. Sin esa clave continúa la voz local de Windows. La conexión neuronal está implementada, pero requiere una clave para probar su audio real.

- Conectar autenticación y las APIs reales de cuenta antes de mostrar saldo, factura o ejecutar compras.
- Reemplazar los precios de ejemplo por una fuente actualizada y verificable.
- Configurar un gestor de secretos si se publica el asistente.
- Rotar la clave de Niro que fue compartida en el chat antes de publicar el proyecto.
