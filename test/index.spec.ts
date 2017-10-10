import { queryItemAttributes } from '..';

Promise.resolve()
.then(() => queryItemAttributes('ring', 'ascended', 80))
.then((v) => {
  console.log('acended ring');
  console.log(v);
}, (e) => console.error(e));

Promise.resolve()
.then(() => queryItemAttributes('rifle', 'legendary', 80))
.then((v) => {
  console.log('legendary rifle');
  console.log(v);
}, (e) => console.error(e));
