// Ventanita de "Acceder con Google": sin llaves de acceso (passkeys).
// Las passkeys de Google viven en Chrome/Edge; adentro de la app Windows no las encuentra y pide una "clave de seguridad USB".
// Sin esa opción, Google pide la contraseña (y el código del celular si lo tenés), como siempre.
const { webFrame } = require('electron');
webFrame.executeJavaScript(`try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); if (navigator.credentials) { const g = navigator.credentials.get.bind(navigator.credentials); navigator.credentials.get = o => (o && o.publicKey) ? Promise.reject(new DOMException('No disponible', 'NotAllowedError')) : g(o); } } catch (e) {}`);
