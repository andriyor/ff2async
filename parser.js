const { parse } =  require('meriyah');
const  astray = require('astray')
const  fs = require('fs');
const escodegen = require("escodegen");
const util = require('util')
const  code = fs.readFileSync('ffExample.js', 'utf8');
const klona = require('klona/json');

// console.log(parse(code));

const AST = parse(code)

const expressionStatements = []
const toPromisify = {

}

astray.walk(AST, {
  CallExpression(callExpression, state) {
    if (callExpression.callee.name === 'ff') {
      // console.log(node);
      astray.walk(callExpression, {
        ExpressionStatement(expressionStatement, state) {
          astray.walk(expressionStatement, {
            CallExpression(callExpression, state) {
              if (callExpression.callee.property && callExpression.callee.property.name === 'slot') {
                // console.log(callExpression);
                // remove last f.slot() argument
                expressionStatement.expression.arguments.pop()

                // promisify callback functions

                if (expressionStatement.expression.callee.name) {
                  const promisedName = `promised${expressionStatement.expression.callee.name}`
                  toPromisify[promisedName] = {...expressionStatement.expression.callee}
                  expressionStatement.expression.callee.name = promisedName
                }

                if (expressionStatement.expression.callee.object && expressionStatement.expression.callee.property) {
                  const promisedName = `promised${expressionStatement.expression.callee.object.name + expressionStatement.expression.callee.property.name}`
                  toPromisify[promisedName] = {...expressionStatement.expression.callee}

                  expressionStatement.expression.callee.name = promisedName
                  expressionStatement.expression.callee.type = 'Identifier'
                  delete expressionStatement.expression.callee.object
                  delete expressionStatement.expression.callee.property

                }


                expressionStatements.push(expressionStatement)
              }
            }
          })
        }
      })
    }
  },
});


const as = parse('const preadFile = util.promisify(fs.readFile)')
// console.log(as);
// console.log(util.inspect(as, false, null, true /* enable colors */))

// console.log(expressionStatements);
expressionStatements.forEach(astStatement => {
  console.log(escodegen.generate(astStatement));
})




console.log(escodegen.generate({
  type: 'BinaryExpression',
  operator: '+',
  left: {type: 'Literal', value: 40},
  right: {type: 'Literal', value: 2}
}));


//promisify
// console.log(escodegen.generate({
//     type: 'VariableDeclaration',
//     kind: 'const',
//     declarations: [
//       {
//         type: 'VariableDeclarator',
//         id: { type: 'Identifier', name: 'preadFile' },
//         init: {
//           type: 'CallExpression',
//           callee: {
//             type: 'MemberExpression',
//             object: { type: 'Identifier', name: 'util' },
//             computed: false,
//             property: { type: 'Identifier', name: 'promisify' }
//           },
//           arguments: [
//             {
//               type: 'MemberExpression',
//               object: { type: 'Identifier', name: 'fs' },
//               computed: false,
//               property: { type: 'Identifier', name: 'readFile' }
//             }
//           ]
//         }
//       }
//     ]
//   }
// ))

console.log(Object.values(toPromisify).length);
console.log(Object.entries(toPromisify).map(([name, memberExpression]) => escodegen.generate({
    type: 'VariableDeclaration',
    kind: 'const',
    declarations: [
      {
        type: 'VariableDeclarator',
        id: { type: 'Identifier', name: `${name}` },
        init: {
          type: 'CallExpression',
          callee: {
            type: 'MemberExpression',
            object: { type: 'Identifier', name: 'util' },
            computed: false,
            property: { type: 'Identifier', name: 'promisify' }
          },
          arguments: [
            memberExpression
          ]
        }
      }
    ]
  }
)))

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
  kind: "const"
}));

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
          name: "preadFile",
        },
        arguments: []
      }
    }
  }],
  kind: "const"
}));



