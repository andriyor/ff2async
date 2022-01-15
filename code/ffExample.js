const fs = require("fs");
const path = require("path");

const ff = require("ff");

function sortFileContents(fileA, fileB, cb) {
  const namesA = fileA.split("\n").filter(Boolean);
  const namesB = fileB.split("\n").filter(Boolean);
  return cb(
    null,
    namesA.concat(namesB).sort(function (a, b) {
      return a.localeCompare(b);
    })
  );
}

ff(
  function () {
    fs.readFile(path.join(__dirname, "mock/1.txt"), "utf8", f.slot());
    fs.readFile(path.join(__dirname, "mock/2.txt"), "utf8", f.slot());
  },
  function (fileA, fileB) {
    sortFileContents(fileA, fileB, f.slot());
  },
  function (result) {
    f.pass(result.join("\n"));
  }
)
  .onComplete(function (err, users) {
    console.log(users);
  })
  .onError(function (err) {
    console.log(err);
  });
