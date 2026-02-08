# Crash Aviador (Demo) — Ciclos constantes

Este proyecto es **frontend puro** (HTML/CSS/JS) listo para GitHub + Netlify.

Incluye:
- Avión como imagen: `assets/plane.png`
- Explosión como GIF: `assets/explosion.gif`
- Línea (trail) detrás del avión (canvas)
- Ciclo infinito:
  - 30s apuestas abiertas
  - Vuelo hasta crash
  - 5s resultado mostrado
- Persistencia del ciclo con `localStorage` (si recargas, continúa)

## Probar con Node

Requisito: Node.js 18+

1) Instalar servidor estático:
```bash
npm install
```

2) Correr:
```bash
npm run dev
```

Abrir: http://localhost:5173

## Deploy en Netlify
- Publish directory: `.`
- Build command: (vacío)
