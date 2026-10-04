/* Stands in for the bridge Capacitor injects into the page, so the built web
 * client can be opened as the installed phone app would open it - without an
 * Android device in the room. Only the one fact the client asks about. */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('Capacitor', {
  isNativePlatform: () => true,
  getPlatform: () => 'android'
});