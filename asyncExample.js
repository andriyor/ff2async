const fs = require('fs');
const path = require('path');

const ff = require('ff');
const util = require('util');


function sortFileContents(fileA, fileB, cb) {
  const namesA = fileA.split('\n').filter(Boolean);
  const namesB = fileB.split('\n').filter(Boolean);
  cb(null, namesA.concat(namesB).sort(function (a, b) {
    return a.localeCompare(b);
  }));
}

(async () => {
  const promSortFileContents = util.promisify(sortFileContents)
  const preadFile = util.promisify(fs.readFile)
  const fileA = await preadFile(path.join(__dirname, 'mock/1.txt'), 'utf8');
  const fileB = await preadFile(path.join(__dirname, 'mock/2.txt'), 'utf8');
  const result = await promSortFileContents(fileA, fileB);
  console.log(result.join('\n'));
})();


