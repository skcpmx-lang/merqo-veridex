/**
 * VERIDEX — field names that identify a person or a device.
 *
 * This module has no imports on purpose. The renderer has to agree with the main process about
 * which field names are personal (the Privacy page prints the guarantees, the Reports page
 * prints what will be withheld), and the renderer is sandboxed: importing anything that reaches
 * `node:*` fails the whole module graph and the window never boots. Moving the list here means
 * both sides read one list without the renderer pulling in the logger's filesystem code.
 */

/** Keys whose values are redacted wherever they appear in a log record. */
export const SENSITIVE_KEYS = Object.freeze([
  'serial',
  'serialnumber',
  'serial_number',
  'serialnumberid',
  'mac',
  'macaddress',
  'ip',
  'ipv4',
  'ipv6',
  'ipaddress',
  'hostname',
  'host',
  'username',
  'user',
  'account',
  'accountname',
  'ssid',
  'wifi',
  'computername',
  'deviceid',
  'machineguid',
  'windowsproductid',
  'productid',
  'productkey',
  'licensekey',
  'token',
  'password',
  'secret',
  'bitlockerkey',
  'recoverykey',
  // Command lines are never logged, and these keys are what a caller would use if it tried.
  // Refusing the key is weaker than refusing to pass one, but it is the last line: the
  // runner's logging path already records only the exit code.
  'commandline',
  'cmdline',
  'command',
  'args',
  'argv',
  'arguments'
]);
