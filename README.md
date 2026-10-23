# Northstar Market Research

Dashboard de análisis creado desde cero para acciones de EE. UU. y cripto. Conecta datos reales en vivo; no contiene funciones de trading.

## Incluye

- Overview y watchlist con cotizaciones recibidas en tiempo real.
- Cripto spot de Binance con feed público.
- Acciones de EE. UU. con Alpaca IEX mediante claves guardadas solo en el servidor local.
- Gráficas OHLC, datos históricos y backtesting calculado sobre los datos descargados.
- Research técnico y fundamental con históricos SEC; rendimiento por periodos, rango de 52 semanas y tendencias mensuales de consenso Finnhub cuando se configura una clave gratuita.
- Estrategias simples de cruce de medias y momentum, con métricas calculadas para el periodo elegido.
- Analítica, estado de fuentes y etiquetas de proveedor/hora.

No hay Paper Trading, Portafolio, conexión de cuenta de trading ni endpoints que envíen órdenes.

## Fuentes y alcance

- **Cripto:** Binance Spot publica un stream de ticker de mercado. La app usa BTC/USDT, ETH/USDT y SOL/USDT para mostrar valores BTC/USD, ETH/USD y SOL/USD, respectivamente; es una conversión nominal a USDT y puede diferir del USD.
- **Acciones de EE. UU.:** Alpaca IEX ofrece el feed gratuito en tiempo real de una sola bolsa. No es la cinta consolidada SIP y su cobertura/volumen puede diferir de otras fuentes. Requiere cuenta gratuita y claves de datos.
- **Consenso mensual:** Finnhub entrega conteos agregados de compra, mantener y venta, no movimientos individuales ni precios objetivo. **Movimientos individuales de analistas:** el conector anterior de FMP no tiene acceso gratuito confirmado para esta aplicación; no se muestran filas de ejemplo ni datos inferidos.
- **Forex, commodities y cotizaciones consolidadas de acciones no están incluidos.** Las velas de cada fuente pueden tener límites de historial y disponibilidad según sesión, símbolo y cuenta.

El precio justo es una estimación exploratoria: multiplica métricas financieras actuales por la mediana de múltiplos positivos propios observados después de cada presentación anual SEC, exige al menos dos observaciones y agrega la mediana de las estimaciones disponibles. P25/P75 son percentiles históricos; no hay comparables sectoriales ni puntuación de confianza.

Rendimientos: 1D, 1W, 1M, 3M, YTD, 1A y 5A usan barras diarias reales; acciones cuentan sesiones bursátiles y cripto días calendario. Son retornos de precio sin dividendos. El rango usa los extremos diarios observados en las 252 sesiones o 365 días disponibles; la amplitud no equivale a volatilidad. La tabla anual de ingresos, BPA, margen neto y FCF se deriva de formularios SEC y puede omitir datos que no coinciden exactamente por ejercicio fiscal. El material de referencia no define el método para una puntuación de confianza ni aporta datos de pares sectoriales, por lo que no se inventan.

La pantalla no rellena precios ausentes con datos inventados. Si una fuente no está conectada, muestra que falta configuración o historial.

## Configurar Alpaca para acciones

1. Crea una cuenta **Paper Only** gratuita en Alpaca y genera las claves de datos de esa cuenta. No uses claves de una cuenta de trading real.
2. Copia .env.example como .env.
3. Escribe localmente APCA_API_KEY_ID y APCA_API_SECRET_KEY en .env. No las pegues en el chat ni en el navegador.
4. Reinicia el servidor.

El backend local usa esas claves solo para autenticar datos de mercado y no tiene rutas de órdenes.

## Tendencias de consenso

Obtén una clave personal de Finnhub y comprueba que tu nivel de cuenta habilite Recommendation Trends; guárdala como `FINNHUB_API_KEY` en `.env`; no la pegues en el navegador ni en el chat. Reinicia el servidor. Se consultan tendencias mensuales agregadas de recomendaciones y se guardan localmente durante seis horas. La disponibilidad del endpoint depende del nivel y cobertura vigentes de Finnhub. Aun disponible, no sustituye la tabla de cambios individuales ni incluye objetivos de precio.

## Iniciar en esta PC

Requiere Node.js 20 o posterior y la dependencia gratuita ws.

~~~powershell
.\start.cmd
~~~

Abre http://127.0.0.1:4174 en el mismo equipo. Detén el servidor con Ctrl+C. Si ejecutas este proyecto fuera de la carpeta contenedora actual, instala las dependencias con npm install.

## Alojamiento en Render

El archivo `render.yaml` prepara un servicio web de Node en el plan gratuito. Render recibe el codigo desde un repositorio de GitHub y aloja el servidor; GitHub no ejecuta el backend por si mismo.

- Antes de publicar, configura `DASHBOARD_PASSWORD` en Environment de Render con una contrasena aleatoria de al menos 16 caracteres. El servidor de produccion se detiene si falta esta contrasena.
- Configura cualquier clave de datos que vayas a usar (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `FINNHUB_API_KEY`, `FMP_API_KEY`) directamente como variable privada del servicio en Render. No subas `.env`, claves ni contrasenas a GitHub ni las pegues en el chat.
- La pantalla de acceso crea una sesion protegida con cookie HttpOnly, SameSite y Secure en produccion; el acceso con contrasena y los datos de la app quedan protegidos, incluida la conexiÃ³n WebSocket.
- Un servicio web gratuito de Render tiene URL publica, por eso la contrasena es obligatoria. Puede suspenderse tras 15 minutos sin actividad y tardar cerca de un minuto en volver a responder. La primera solicitud puede mostrar una espera.

El servicio usa `PORT` de Render y enlaza a `0.0.0.0` solo en produccion; el servidor local sigue limitado a `127.0.0.1` salvo que se solicite explicitamente el modo LAN.

## Abrir en otro dispositivo de la misma red

~~~powershell
.\start.cmd -Lan
~~~

El script selecciona una dirección IPv4 privada de la PC y enlaza el servidor a esa dirección específica; no usa 0.0.0.0 ni configura puertos públicos. La terminal muestra la dirección que se debe abrir en el otro dispositivo. Windows puede bloquear conexiones entrantes según el perfil de red o el firewall.

## Arquitectura

- index.html: secciones y componentes de la interfaz.
- styles.css: tema visual adaptable a escritorio, tablet y móvil.
- app.js: navegación, gráficas OHLC y cálculos locales sobre velas del proveedor.
- server.mjs: proxy local para WebSocket, snapshots y velas históricas.
- .env.example: plantilla de credenciales; .env está excluido de Git.
- start.cmd / start.ps1: servidor de Node enlazado a localhost o a una IP LAN privada.

Las acciones muestran cambios contra el cierre diario anterior de IEX; el ticker cripto muestra su variación móvil de 24 horas. El sistema indica el proveedor para no confundir ambas referencias.

## Indicadores técnicos y fundamentales

La vista Gráficas calcula SMA 21/50/100/200, EMA 21/50/100/200, Hull MA 9, VWMA 20, Ichimoku 9/26/52, RSI 14, Estocástico, CCI 20, ADX 14, Awesome Oscillator, Momentum 10, MACD 12/26/9, Stoch RSI 14, Williams %R 14, Bull Bear Power 13 y Ultimate Oscillator a partir de las velas reales cargadas.

Para acciones compatibles, el servidor consulta SEC CompanyFacts y presenta fundamentales de los últimos ejercicios anuales reportados. Las razones que requieren una cotización solo se calculan si existe un tick IEX real. El consenso mensual usa Finnhub solo si está configurada la clave local. No se inventan objetivos de analistas ni registros individuales.
