/**
 * Python Full Course — static content module.
 *
 * Pure data (no DB access, no Express). server.js requires this and wires
 * it up to real routes + the per-student PythonCourseProgress collection.
 *
 * Content is authored in full for Module 1 (Python Fundamentals) and one
 * demo lesson in Module 4 (List Introduction — the exact example from the
 * course brief) to prove out the whole learn → practice → test → progress
 * pipeline end to end. Every other module/lesson from the brief's outline
 * exists as a real, unlockable, completable lesson (so progress %, module
 * bars, locking, and the dashboard all work across the full 15-module
 * course today) but with placeholder "content coming soon" learn content
 * and a single-question review test, ready for an instructor/admin to
 * replace via the future content-management routes (see server.js comment
 * near PY_COURSE_ADMIN_NOTE). Nothing about the schema changes when real
 * content is dropped in — only the `learn` and `test.questions` fields.
 */

let AUTO_ID = 0;
function qid(prefix) { AUTO_ID += 1; return `${prefix}${AUTO_ID}`; }

// A trivial one-question "review" test used only by stub lessons, so the
// same completion pipeline (view content -> take test -> lesson complete)
// works uniformly even before real test questions are authored for a
// lesson. Real lessons below define their own richer `test.questions`.
function stubTest(topic) {
  return {
    questions: [
      {
        id: qid('stubq'),
        type: 'mcq',
        text: `Quick check — have you read through the "${topic}" material above?`,
        options: ['Yes, I read it', 'I skimmed it', 'Not yet', 'I will come back later'],
        correct_index: 0
      }
    ]
  };
}

function stubLesson(order, title) {
  return {
    order,
    title,
    est_minutes: 10,
    content_ready: false,
    learn: {
      explanation: `Content for "${title}" is coming soon. Your instructor can publish the full lesson (explanation, syntax, examples, common mistakes) through the course content tools without changing where this lesson lives in the course.`,
      syntax: '',
      examples: [],
      important_points: [],
      common_mistakes: [],
      real_world: ''
    },
    practice: null,
    test: stubTest(title)
  };
}

function lesson(order, title, estMinutes, learn, practice, test) {
  return { order, title, est_minutes: estMinutes, content_ready: true, learn, practice, test };
}

// ---------------------------------------------------------------------------
// Module 1 — Python Fundamentals (fully authored)
// ---------------------------------------------------------------------------
const module1Lessons = [
  lesson(1, 'Introduction to Python', 6, {
    explanation: 'Python is a high-level, general-purpose programming language known for its simple, readable syntax. It is used for web development, data science, automation, AI/ML, and much more. Unlike many languages, Python code reads almost like plain English, which makes it a popular first language.',
    syntax: '',
    examples: [{ code: "print(\"Hello, World!\")", output: 'Hello, World!' }],
    important_points: [
      'Python is interpreted, not compiled — code runs line by line.',
      'Python is dynamically typed — you don\'t declare variable types.',
      'Indentation (not braces) defines code blocks in Python.'
    ],
    common_mistakes: ['Forgetting that Python is case-sensitive (Print vs print).', 'Mixing tabs and spaces for indentation.'],
    real_world: 'Instagram, Spotify, and Netflix all use Python somewhere in their backend or data pipelines.'
  }, { starter_code: 'print("Hello, World!")\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Python is an example of which type of language?', options: ['Compiled only', 'Interpreted', 'Machine language', 'Assembly'], correct_index: 1 },
      { id: qid('q'), type: 'truefalse', text: 'Python is case-sensitive.', correct_index: 0, options: ['True', 'False'] },
      { id: qid('q'), type: 'code', text: 'Write a Python program that prints exactly: Hello, Campus Orbis!', language: 'python', starter_code: '# write your code here\n', test_cases: [{ input: '', expected_output: 'Hello, Campus Orbis!' }] }
    ]
  }),
  lesson(2, 'Python Features', 5, {
    explanation: 'Python is popular because it is easy to learn, has a huge standard library, runs on every major platform, and has a massive ecosystem of third-party packages (via pip). It supports multiple programming styles: procedural, object-oriented, and functional.',
    syntax: '',
    examples: [{ code: "import platform\nprint(platform.python_version())", output: '3.x.x' }],
    important_points: ['Free and open source.', 'Portable across Windows/macOS/Linux.', 'Huge standard library ("batteries included").'],
    common_mistakes: ['Assuming Python is always the fastest choice — it trades some raw speed for developer productivity.'],
    real_world: 'Data scientists pick Python largely because of its features/libraries like pandas and NumPy.'
  }, { starter_code: "import platform\nprint(platform.python_version())\n" }, stubTest('Python Features')),
  lesson(3, 'Installing / Running Python', 5, {
    explanation: 'Python code can run two ways: interactively in a REPL (type a line, see the result immediately) or as a saved .py script run with `python filename.py`. On Campus Orbis, you can try Python instantly using the built-in compiler — no install needed.',
    syntax: 'python filename.py',
    examples: [{ code: 'print(1 + 1)', output: '2' }],
    important_points: ['The Campus Orbis compiler already has Python ready — just click "Try in Compiler".', '.py is the standard file extension for Python scripts.'],
    common_mistakes: ['Forgetting to save a script before running it locally.'],
    real_world: 'Beginners usually start in a REPL/notebook, then move to full scripts as programs grow.'
  }, { starter_code: 'print(1 + 1)\n' }, stubTest('Installing / Running Python')),
  lesson(4, 'Variables', 6, {
    explanation: 'A variable is a name that refers to a value stored in memory. Python variables don\'t need a declared type — the type is inferred from the value assigned, and can change later.',
    syntax: 'variable_name = value',
    examples: [{ code: 'name = "Ravi"\nage = 20\nprint(name, age)', output: 'Ravi 20' }],
    important_points: ['Variable names must start with a letter or underscore.', 'Variable names are case-sensitive.', 'Use descriptive names (student_name, not x).'],
    common_mistakes: ['Starting a variable name with a digit (2name — invalid).', 'Using Python keywords as variable names (class, for, etc).'],
    real_world: 'Every program — from a calculator to a website backend — stores data in variables.'
  }, { starter_code: 'name = "Ravi"\nage = 20\nprint(name, age)\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which of these is a valid Python variable name?', options: ['2total', 'total_2', 'total-2', 'class'], correct_index: 1 },
      { id: qid('q'), type: 'output', text: 'What is the output?\nx = 5\nx = x + 1\nprint(x)', options: ['5', '6', 'Error', 'x + 1'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Create a variable `city` with the value "Hyderabad" and print it.', language: 'python', starter_code: '# write your code here\n', test_cases: [{ input: '', expected_output: 'Hyderabad' }] }
    ]
  }),
  lesson(5, 'Data Types', 6, {
    explanation: 'Python has several built-in data types: int (whole numbers), float (decimals), str (text), bool (True/False), list, tuple, dict, and set. Use type() to check a value\'s type at any time.',
    syntax: 'type(value)',
    examples: [{ code: 'print(type(10))\nprint(type(3.14))\nprint(type("hi"))\nprint(type(True))', output: "<class 'int'>\n<class 'float'>\n<class 'str'>\n<class 'bool'>" }],
    important_points: ['int and float are both numeric but behave differently in division.', 'Strings are immutable.', 'bool is technically a subtype of int (True == 1).'],
    common_mistakes: ["Comparing a string number like \"5\" to an int 5 and expecting True."],
    real_world: 'Choosing the right data type (e.g. float for money-like calculations) avoids subtle bugs.'
  }, { starter_code: 'print(type(10))\nprint(type(3.14))\nprint(type("hi"))\nprint(type(True))\n' }, stubTest('Data Types')),
  lesson(6, 'Input and Output', 6, {
    explanation: 'print() displays output. input() reads a line of text typed by the user (always returned as a string, so convert it with int()/float() if you need a number).',
    syntax: 'input(prompt)',
    examples: [{ code: 'name = input("Enter your name: ")\nprint("Hello", name)', output: 'Enter your name: (waits for input)\nHello <what you typed>' }],
    important_points: ['input() always returns a str.', 'Use int(input()) to read a number directly.'],
    common_mistakes: ['Forgetting to convert input() before doing arithmetic on it.'],
    real_world: 'Command-line tools and simple games rely on input()/print() for the whole interaction.'
  }, { starter_code: 'name = input("Enter your name: ")\nprint("Hello", name)\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'What type does input() always return?', options: ['int', 'float', 'str', 'bool'], correct_index: 2 },
      { id: qid('q'), type: 'code', text: 'Read a number from input and print its square.', language: 'python', starter_code: 'n = int(input())\n', test_cases: [{ input: '4', expected_output: '16' }, { input: '7', expected_output: '49' }] }
    ]
  }),
  lesson(7, 'Type Casting', 5, {
    explanation: 'Type casting converts a value from one type to another using int(), float(), str(), or bool().',
    syntax: 'int(value) / float(value) / str(value) / bool(value)',
    examples: [{ code: 'x = "10"\ny = int(x) + 5\nprint(y)', output: '15' }],
    important_points: ['int("10.5") raises an error — go through float() first.', 'str(123) turns a number into text for concatenation.'],
    common_mistakes: ['Trying int("abc") — raises ValueError.'],
    real_world: 'Reading numeric form-fields from a web request almost always needs a type cast.'
  }, { starter_code: 'x = "10"\ny = int(x) + 5\nprint(y)\n' }, stubTest('Type Casting')),
  lesson(8, 'Operators', 6, {
    explanation: 'Python has arithmetic (+ - * / // % **), comparison (== != < > <= >=), logical (and or not), and assignment (= += -= ...) operators.',
    syntax: 'a + b, a // b, a ** b',
    examples: [{ code: 'print(7 // 2)\nprint(7 % 2)\nprint(2 ** 3)', output: '3\n1\n8' }],
    important_points: ['// is floor (integer) division.', '** is exponentiation, not ^.', 'and/or/not are used instead of &&/||/!.'],
    common_mistakes: ['Using / when // (integer division) was intended.'],
    real_world: 'Billing systems use % and // for splitting totals into units and remainders.'
  }, { starter_code: 'print(7 // 2)\nprint(7 % 2)\nprint(2 ** 3)\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does print(10 % 3) output?', options: ['3', '1', '3.33', '0'], correct_index: 1 },
      { id: qid('q'), type: 'mcq', text: 'Which operator is used for exponentiation in Python?', options: ['^', '**', 'exp()', '%%'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Write a program that reads two integers (one per line) and prints their sum.', language: 'python', starter_code: 'a = int(input())\nb = int(input())\n', test_cases: [{ input: '2\n3', expected_output: '5' }, { input: '10\n20', expected_output: '30' }] }
    ]
  }),
  lesson(9, 'Comments', 4, {
    explanation: 'Comments explain code and are ignored by Python. Use # for a single line. There\'s no true multi-line comment, but a triple-quoted string not assigned to anything is often used that way.',
    syntax: '# this is a comment',
    examples: [{ code: '# This prints a greeting\nprint("Hi")  # inline comment', output: 'Hi' }],
    important_points: ['Comments should explain WHY, not just WHAT.', 'Good comments make code easier to maintain.'],
    common_mistakes: ['Over-commenting obvious code, or under-commenting tricky logic.'],
    real_world: 'Professional codebases require comments/docstrings for anything non-obvious.'
  }, { starter_code: '# This prints a greeting\nprint("Hi")  # inline comment\n' }, stubTest('Comments'))
];

// ---------------------------------------------------------------------------
// Module 4 — Lists: one fully authored demo lesson (matches the brief's
// own worked example exactly), rest of Module 4 stubbed like every later
// module below.
// ---------------------------------------------------------------------------
const listIntroLesson = lesson(1, 'List Introduction', 7, {
  explanation: 'A list is an ordered, changeable collection of items, written with square brackets. Lists can hold any mix of data types and are one of the most-used data structures in Python.',
  syntax: 'my_list = [item1, item2, item3]',
  examples: [{ code: 'numbers = [10, 20, 30, 40]\nprint(numbers)', output: '[10, 20, 30, 40]' }],
  important_points: ['Lists are ordered — items keep their insertion position.', 'Lists are mutable — you can change them after creation.', 'Lists can contain duplicate values.'],
  common_mistakes: ['Confusing a list [ ] with a tuple ( ) — tuples are immutable.', 'Forgetting list indexes start at 0.'],
  real_world: 'A shopping cart, a to-do app, and a leaderboard are all naturally modeled as lists.'
}, { starter_code: 'numbers = [10, 20, 30, 40]\nprint(numbers)\n' }, {
  questions: [
    { id: qid('q'), type: 'mcq', text: 'Which method adds an element to the end of a list?', options: ['remove()', 'append()', 'delete()', 'add()'], correct_index: 1 },
    { id: qid('q'), type: 'output', text: 'What is the output?\nnumbers = [10, 20, 30, 40]\nprint(numbers[1])', options: ['10', '20', '30', 'Error'], correct_index: 1 },
    { id: qid('q'), type: 'code', text: 'Given a list [10, 20, 30, 40] already in your code, print the sum of its elements.', language: 'python', starter_code: 'numbers = [10, 20, 30, 40]\nprint(sum(numbers))\n', test_cases: [{ input: '', expected_output: '100' }] }
  ]
});

// ---------------------------------------------------------------------------
// Full course outline (titles from the brief) — used to build every module.
// Module 1 and the first lesson of Module 4 use the hand-authored lessons
// above; everything else is generated as a real, completable stub lesson.
// ---------------------------------------------------------------------------
const OUTLINE = [
  { id: 'm1', title: 'Python Fundamentals', tier: 'beginner', lessons: module1Lessons.map(l => l.title) },
  { id: 'm2', title: 'Control Flow', tier: 'beginner', lessons: ['if Statement', 'if-else', 'elif', 'Nested Conditions', 'for Loop', 'while Loop', 'break', 'continue', 'pass', 'Nested Loops'] },
  { id: 'm3', title: 'Strings', tier: 'beginner', lessons: ['String Basics', 'String Indexing', 'String Slicing', 'String Methods', 'String Formatting', 'f-Strings', 'String Practice'] },
  { id: 'm4', title: 'Lists', tier: 'beginner', lessons: ['List Introduction', 'Creating Lists', 'Indexing', 'Slicing', 'Adding Elements', 'Removing Elements', 'List Methods', 'Nested Lists', 'List Comprehension', 'List Practice'] },
  { id: 'm5', title: 'Tuples, Sets and Dictionaries', tier: 'beginner', lessons: ['Tuple Basics', 'Tuple Indexing', 'Tuple Methods', 'Tuple Unpacking', 'Set Basics', 'Set Add/Remove', 'Set Union', 'Set Intersection', 'Set Difference', 'Dictionary Basics', 'Dictionary Keys and Values', 'Adding/Updating Data', 'Removing Data', 'Dictionary Methods', 'Nested Dictionaries'] },
  { id: 'm6', title: 'Functions', tier: 'intermediate', lessons: ['Function Basics', 'Parameters', 'Arguments', 'Return Values', 'Default Arguments', 'Keyword Arguments', 'Variable-length Arguments', 'Scope', 'Lambda Functions', 'Recursion'] },
  { id: 'm7', title: 'Modules and Packages', tier: 'intermediate', lessons: ['Modules', 'import', 'from import', 'Built-in Modules', 'Creating Custom Modules', 'Packages', 'pip'] },
  { id: 'm8', title: 'File Handling', tier: 'intermediate', lessons: ['Opening Files', 'Reading Files', 'Writing Files', 'Appending Files', 'File Modes', 'with Statement', 'Working with CSV', 'Working with JSON'] },
  { id: 'm9', title: 'Exception Handling', tier: 'intermediate', lessons: ['Errors vs Exceptions', 'try', 'except', 'else', 'finally', 'raise', 'Custom Exceptions'] },
  { id: 'm10', title: 'Object-Oriented Programming', tier: 'intermediate', lessons: ['Classes', 'Objects', 'Constructor', 'self', 'Instance Variables', 'Methods', 'Encapsulation', 'Inheritance', 'Multiple Inheritance', 'Polymorphism', 'Abstraction'] },
  { id: 'm11', title: 'Advanced Python', tier: 'advanced', lessons: ['Iterators', 'Generators', 'Decorators', 'Comprehensions', 'Regular Expressions', 'Context Managers', 'Advanced Functions'] },
  { id: 'm12', title: 'Python + Database', tier: 'advanced', lessons: ['Database Basics', 'SQLite', 'Connecting Python with Database', 'CRUD Operations', 'SQL Queries from Python'] },
  { id: 'm13', title: 'Python APIs', tier: 'advanced', lessons: ['HTTP Basics', 'APIs', 'JSON', 'GET', 'POST', 'API Response Handling', 'Python API Project'] },
  { id: 'm14', title: 'DSA with Python', tier: 'advanced', lessons: ['Arrays/Lists', 'Stack', 'Queue', 'Searching', 'Sorting', 'Linked List Basics', 'Trees Basics', 'Problem Solving'] },
  { id: 'm15', title: 'Real-world Projects', tier: 'advanced', lessons: ['Calculator', 'Number Guessing Game', 'Quiz Application', 'Student Management System', 'Expense Tracker', 'Contact Management System', 'Weather API Application', 'Final Python Project'] }
];

const HAND_AUTHORED = {
  m1: module1Lessons,
  m2: require('./pythonModulesA').M2,
  m3: require('./pythonModulesA').M3,
  m4: [listIntroLesson, ...require('./pythonModulesA').M4],
  m5: require('./pythonModulesA').M5,
  m6: require('./pythonModulesA').M6,
  m7: require('./pythonModulesA').M7,
  m8: require('./pythonModulesA').M8,
  m9: require('./pythonModulesB').M9,
  m10: require('./pythonModulesB').M10,
  m11: require('./pythonModulesB').M11,
  m12: require('./pythonModulesB').M12,
  m13: require('./pythonModulesB').M13,
  m14: require('./pythonModulesB').M14,
  m15: require('./pythonModulesB').M15
};

function buildCourse() {
  const modules = OUTLINE.map((m, mi) => {
    const authored = HAND_AUTHORED[m.id] || [];
    const lessons = m.lessons.map((title, li) => {
      const order = li + 1;
      const authoredLesson = authored.find(a => a.order === order);
      const base = authoredLesson || stubLesson(order, title);
      return {
        id: `${m.id}-l${order}`,
        module_id: m.id,
        ...base
      };
    });
    return { id: m.id, order: mi + 1, title: m.title, tier: m.tier || 'beginner', lessons };
  });

  const lessonIndex = new Map();
  const orderedLessonIds = [];
  modules.forEach(m => {
    m.lessons.forEach(l => {
      lessonIndex.set(l.id, l);
      orderedLessonIds.push(l.id);
    });
  });

  return { modules, lessonIndex, orderedLessonIds };
}

const COURSE = buildCourse();
const TOTAL_LESSONS = COURSE.orderedLessonIds.length;

module.exports = { COURSE, TOTAL_LESSONS };
