import { AdapterError } from './command.js';
import { matchUiNode, type UiNode } from './ui-snapshot.js';

export const OBLIVION_PACKAGE = 'net.oblivion.wipe';
export const OBLIVION_SIGNER = 'cc7ea11578ca4339997b0473118ec8c83ed6046834a7b684acf08b174e21ea98';

export function oblivionKeyField(nodes: UiNode[], resource: string): string {
  const node = matchUiNode(nodes, { resourceId: `${OBLIVION_PACKAGE}:id/${resource}` }, OBLIVION_PACKAGE);
  const value = node?.attributes['text'];
  if (
    !value ||
    node?.attributes['class'] !== 'android.widget.TextView' ||
    node.attributes['password'] === 'true' ||
    value.length > 16_384 ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  )
    throw new AdapterError('Expected Oblivion key field is missing or malformed');
  return value;
}

export function readOblivionDialogKey(main: UiNode[], dialog: UiNode[]): string {
  const key = oblivionKeyField(dialog, 'QRcontent');
  if (key !== oblivionKeyField(main, 'idDisplay')) throw new AdapterError('Oblivion key fields do not match');
  return key;
}
