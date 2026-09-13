import {randomBytes,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=process.argv[2];
if(!output)throw new Error('Pass a private output file path outside version control.');
const token=randomBytes(32).toString('base64url');
await writeFile(resolve(output),token+'\n',{flag:'wx',mode:0o600});
console.log('WHAT_THE_REPO_ADMIN_BOOTSTRAP_SHA256='+createHash('sha256').update(token).digest('hex'));
console.log('Bootstrap credential saved to the requested private file. It was not printed.');
