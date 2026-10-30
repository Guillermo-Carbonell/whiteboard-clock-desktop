# Whiteboard Clock para Windows

La app de escritorio de Whiteboard Clock. Abre la misma app web (whiteboard-clock.web.app) en su propia ventana, así que todo lo de adentro se actualiza solo con cada deploy de la web.

Lo que suma la app:
- La inactividad se mide desde Windows (mouse y teclado de toda la compu), sin pedir permisos al navegador.
- Los links de afuera (Drive, Discord…) se abren en el navegador predeterminado.
- Arranca con Windows y deja un ícono en la barra (se prende y apaga desde Configuración).
- Se actualiza sola: cuando hay una versión nueva, avisa con un cartel para reiniciar.

## Instalar
Bajá `WhiteboardClock-Setup-X.Y.Z.exe` de la última versión en **Releases** y abrilo.
La primera vez Windows puede mostrar "Windows protegió tu PC": tocá **Más información → Ejecutar de todas formas**.

## Publicar una versión nueva de la app
1. Cambiar `version` en `package.json`.
2. Subir una etiqueta con ese número: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. GitHub Actions arma el instalador y lo publica en Releases; las apps instaladas lo bajan solas.
