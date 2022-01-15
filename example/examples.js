console.log(escodegen.generate({
  type: 'BinaryExpression',
  operator: '+',
  left: { type: 'Literal', value: 40 },
  right: { type: 'Literal', value: 2 }
}));


// const a = await preadFile();
const escodegen = require('escodegen');
const { parse } = require('meriyah');
const util = require('util');
console.log(escodegen.generate({
  type: 'VariableDeclaration',
  declarations: [{
    type: 'VariableDeclarator',
    id: {
      type: 'Identifier',
      name: 'a'
    },
    init: {
      type: 'AwaitExpression',
      argument: {
        type: 'CallExpression',
        callee: {
          type: 'Identifier',
          name: 'preadFile'
        },
        arguments: []
      }
    }
  }],
  kind: 'const'
}));


// const a = 'kek';
console.log(escodegen.generate({
  type: 'VariableDeclaration',
  declarations: [{
    type: 'VariableDeclarator',
    id: {
      type: 'Identifier',
      name: 'a'
    },
    init: {
      type: 'Literal',
      value: 'kek'
    }
  }],
  kind: 'const'
}));

// (async () => {
// })();
console.log(escodegen.generate({
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: {
        type: 'ArrowFunctionExpression',
        params: [],
        body: {
          type: 'BlockStatement',
          body: []
        },
        async: true,
        expression: false
      },
      arguments: []
    }
  }
));


//  generate with semicolons
const ass = parse('const a = "kek"');
console.log('must bee const a = "kek"');
console.log(escodegen.generate(ass, escodegenConfig));
console.log(util.inspect(ass, false, null, true /* enable colors */));



