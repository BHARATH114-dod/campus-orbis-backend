/**
 * Java Full Course — Modules 3-15, authored content ("lighter detail" pass).
 *
 * Fills in the lessons that used to be stubLesson() placeholders so the
 * Java course has real content end-to-end (Beginner + Intermediate +
 * Advanced), matching the depth style of Module 1/2 but shorter per
 * lesson: one explanation, one worked example, 1-2 important points, and
 * a single-question quick check. Required by the Backend/coursesData.js
 * `lesson()` shape: (order, title, est_minutes, learn, practice, test).
 */

let AUTO_ID = 90000; // stays clear of ids already used in coursesData.js
function qid() { AUTO_ID += 1; return `jq${AUTO_ID}`; }

function lesson(order, title, estMinutes, learn, practice, test) {
  return { order, title, est_minutes: estMinutes, content_ready: true, learn, practice, test };
}

// One-question "quick check" test — same mechanism the graded tests
// already use (mcq or code), just a single question so a run through a
// whole module stays fast. type: 'mcq' or 'code'.
function quickCheck(q) {
  if (q.type === 'code') {
    return { questions: [{ id: qid(), type: 'code', text: q.text, language: 'java', starter_code: q.starter_code, test_cases: q.test_cases }] };
  }
  return { questions: [{ id: qid(), type: 'mcq', text: q.text, options: q.options, correct_index: q.correct_index }] };
}

function ex(code, output) { return { code, output }; }

const MAIN = (body) => `public class Main {\n    public static void main(String[] args) {\n${body}\n    }\n}`;

// ---------------------------------------------------------------------
// Module 3 — Arrays and Strings (Beginner)
// ---------------------------------------------------------------------
const M3 = [
  lesson(1, 'Array Basics', 7, {
    explanation: 'An array holds a fixed number of values of the same type, accessed by index starting at 0.',
    syntax: 'int[] numbers = {10, 20, 30};',
    examples: [ex(MAIN('        int[] numbers = {10, 20, 30};\n        System.out.println(numbers[1]);'), '20')],
    important_points: ['Array indexes start at 0, so numbers[1] is the second element.', "An array's length never changes once created — use numbers.length to read it."],
    common_mistakes: ['Accessing an index that does not exist (e.g. numbers[3] on a 3-element array) throws ArrayIndexOutOfBoundsException.'],
    real_world: ''
  }, { starter_code: MAIN('        int[] numbers = {10, 20, 30};\n        System.out.println(numbers[1]);') },
    quickCheck({ text: 'What does numbers[0] refer to in an array?', options: ['The last element', 'The first element', 'The array length', 'An error'], correct_index: 1 })),

  lesson(2, '2D Arrays', 7, {
    explanation: 'A 2D array is an array of arrays — useful for grids, tables, and matrices.',
    syntax: 'int[][] grid = {{1, 2}, {3, 4}};',
    examples: [ex(MAIN('        int[][] grid = {{1, 2}, {3, 4}};\n        System.out.println(grid[1][0]);'), '3')],
    important_points: ['grid[row][col] — the first index picks the row, the second picks the column.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: MAIN('        int[][] grid = {{1, 2}, {3, 4}};\n        System.out.println(grid[1][0]);') },
    quickCheck({ text: 'For int[][] grid = {{1,2},{3,4}}, what is grid[0][1]?', options: ['1', '2', '3', '4'], correct_index: 1 })),

  lesson(3, 'String Basics', 6, {
    explanation: 'A String in Java is an object representing text, written between double quotes.',
    syntax: 'String name = "Java";',
    examples: [ex(MAIN('        String name = "Java";\n        System.out.println(name.length());'), '4')],
    important_points: ['Strings in Java are immutable — methods like .toUpperCase() return a new String rather than changing the original.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: MAIN('        String name = "Java";\n        System.out.println(name.length());') },
    quickCheck({ text: 'What does "Java".length() return?', options: ['3', '4', '5', 'Error'], correct_index: 1 })),

  lesson(4, 'String Methods', 6, {
    explanation: 'Common String methods let you inspect, transform, and search text.',
    syntax: 'str.toUpperCase(); str.substring(0, 3); str.indexOf("a");',
    examples: [ex(MAIN('        String s = "hello";\n        System.out.println(s.toUpperCase());'), 'HELLO')],
    important_points: ['substring(start, end) — end is exclusive, so "hello".substring(0,3) is "hel".'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: MAIN('        String s = "hello";\n        System.out.println(s.toUpperCase());') },
    quickCheck({ text: 'What does "hello".substring(0, 3) return?', options: ['"hel"', '"hell"', '"ello"', '"llo"'], correct_index: 0 })),

  lesson(5, 'StringBuilder', 6, {
    explanation: 'StringBuilder builds text piece by piece efficiently, without creating a new String on every change.',
    syntax: 'StringBuilder sb = new StringBuilder(); sb.append("text");',
    examples: [ex(MAIN('        StringBuilder sb = new StringBuilder();\n        sb.append("Hi ").append("Java");\n        System.out.println(sb.toString());'), 'Hi Java')],
    important_points: ['Use StringBuilder instead of repeated String + String concatenation inside loops — it is much faster.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: MAIN('        StringBuilder sb = new StringBuilder();\n        sb.append("Hi ").append("Java");\n        System.out.println(sb.toString());') },
    quickCheck({ text: 'Which method adds text to a StringBuilder?', options: ['.add()', '.append()', '.push()', '.concat()'], correct_index: 1 })),

  lesson(6, 'Practice', 8, {
    explanation: 'Combine arrays and strings: loop through an array and build a sentence from it.',
    syntax: '',
    examples: [ex(MAIN('        String[] fruits = {"apple", "banana"};\n        for (String f : fruits) {\n            System.out.println(f);\n        }'), 'apple\nbanana')],
    important_points: ['A for-each loop (for (Type x : array)) is the simplest way to visit every element.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: MAIN('        String[] fruits = {"apple", "banana", "cherry"};\n        // print each fruit in uppercase\n') },
    quickCheck({ type: 'code', text: 'Given int[] nums = {1,2,3,4}, print their sum.', starter_code: MAIN('        int[] nums = {1, 2, 3, 4};\n        // print the sum of all elements\n'), test_cases: [{ input: '', expected_output: '10' }] }))
];

// ---------------------------------------------------------------------
// Module 4 — Object-Oriented Programming (Intermediate)
// ---------------------------------------------------------------------
const M4 = [
  lesson(1, 'Classes and Objects', 8, {
    explanation: 'A class is a blueprint for objects; an object is a specific instance built from that blueprint.',
    syntax: 'class Dog { String name; }\nDog d = new Dog();',
    examples: [ex('class Dog {\n    String name;\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Dog d = new Dog();\n        d.name = "Rex";\n        System.out.println(d.name);\n    }\n}', 'Rex')],
    important_points: ['A class groups related data (fields) and behavior (methods) together.', 'new Dog() creates one object; you can create many objects from the same class.'],
    common_mistakes: [],
    real_world: 'Almost everything in Java — Strings, ArrayLists, even exceptions — is an object created from a class.'
  }, { starter_code: 'class Dog {\n    String name;\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Dog d = new Dog();\n        d.name = "Rex";\n        System.out.println(d.name);\n    }\n}' },
    quickCheck({ text: 'What does "new Dog()" do?', options: ['Defines the Dog class', 'Creates a Dog object', 'Deletes a Dog object', 'Nothing without a name'], correct_index: 1 })),

  lesson(2, 'Constructors', 7, {
    explanation: 'A constructor is a special method, matching the class name, that runs automatically when an object is created — it sets up initial values.',
    syntax: 'class Dog {\n    String name;\n    Dog(String n) { name = n; }\n}',
    examples: [ex('class Dog {\n    String name;\n    Dog(String n) { name = n; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Dog d = new Dog("Rex");\n        System.out.println(d.name);\n    }\n}', 'Rex')],
    important_points: ['A constructor has no return type, not even void.'],
    common_mistakes: ['Forgetting that if you write your own constructor, Java no longer gives you a free no-argument one.'],
    real_world: ''
  }, { starter_code: 'class Dog {\n    String name;\n    Dog(String n) { name = n; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Dog d = new Dog("Rex");\n        System.out.println(d.name);\n    }\n}' },
    quickCheck({ text: 'When does a constructor run?', options: ['Every time a method is called', 'Once, when the object is created', 'Only when explicitly called by name', 'Never automatically'], correct_index: 1 })),

  lesson(3, 'this Keyword', 6, {
    explanation: '"this" refers to the current object — it is mainly used to tell a field apart from a parameter with the same name.',
    syntax: 'class Dog {\n    String name;\n    Dog(String name) { this.name = name; }\n}',
    examples: [ex('class Dog {\n    String name;\n    Dog(String name) { this.name = name; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Dog d = new Dog("Rex");\n        System.out.println(d.name);\n    }\n}', 'Rex')],
    important_points: ['this.name is the object\'s field; name (without this) is the constructor parameter.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Dog {\n    String name;\n    Dog(String name) { this.name = name; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Dog d = new Dog("Rex");\n        System.out.println(d.name);\n    }\n}' },
    quickCheck({ text: 'In Dog(String name) { this.name = name; }, what does "this.name" mean?', options: ['A local variable', "The object's own field", 'A static field', 'A syntax error'], correct_index: 1 })),

  lesson(4, 'Encapsulation', 7, {
    explanation: 'Encapsulation means keeping a class\'s fields private and only exposing controlled access through public getter/setter methods.',
    syntax: 'private int age;\npublic int getAge() { return age; }',
    examples: [ex('class Person {\n    private int age;\n    public void setAge(int a) { if (a >= 0) age = a; }\n    public int getAge() { return age; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Person p = new Person();\n        p.setAge(20);\n        System.out.println(p.getAge());\n    }\n}', '20')],
    important_points: ['private fields cannot be accessed directly from outside the class — only through the class\'s own methods.', 'A setter can validate input before storing it (e.g. reject negative ages).'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Person {\n    private int age;\n    public void setAge(int a) { if (a >= 0) age = a; }\n    public int getAge() { return age; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Person p = new Person();\n        p.setAge(20);\n        System.out.println(p.getAge());\n    }\n}' },
    quickCheck({ text: 'Why make a field private and add a getter/setter?', options: ['It runs faster', 'It controls how the field is read/changed', 'Java requires it', 'It saves memory'], correct_index: 1 })),

  lesson(5, 'Static Members', 6, {
    explanation: 'A static field or method belongs to the class itself, not to any one object — it is shared across every instance.',
    syntax: 'static int count = 0;',
    examples: [ex('class Counter {\n    static int count = 0;\n    Counter() { count++; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        new Counter();\n        new Counter();\n        System.out.println(Counter.count);\n    }\n}', '2')],
    important_points: ['You access a static member through the class name (Counter.count), not through an object.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Counter {\n    static int count = 0;\n    Counter() { count++; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        new Counter();\n        new Counter();\n        System.out.println(Counter.count);\n    }\n}' },
    quickCheck({ text: 'A static field is shared:', options: ['Across all objects of the class', 'Only within one object', 'Only inside main()', 'Never — it is a compile error'], correct_index: 0 }))
];

// ---------------------------------------------------------------------
// Module 5 — Inheritance and Polymorphism (Intermediate)
// ---------------------------------------------------------------------
const M5 = [
  lesson(1, 'Inheritance Basics', 8, {
    explanation: 'Inheritance lets one class (the subclass) reuse the fields and methods of another class (the superclass) using "extends".',
    syntax: 'class Dog extends Animal { }',
    examples: [ex('class Animal {\n    void eat() { System.out.println("eating"); }\n}\nclass Dog extends Animal { }\n\npublic class Main {\n    public static void main(String[] args) {\n        Dog d = new Dog();\n        d.eat();\n    }\n}', 'eating')],
    important_points: ['Dog automatically gets Animal\'s eat() method without rewriting it.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Animal {\n    void eat() { System.out.println("eating"); }\n}\nclass Dog extends Animal { }\n\npublic class Main {\n    public static void main(String[] args) {\n        Dog d = new Dog();\n        d.eat();\n    }\n}' },
    quickCheck({ text: 'Which keyword makes one class inherit another?', options: ['implements', 'extends', 'inherits', 'super'], correct_index: 1 })),

  lesson(2, 'super Keyword', 6, {
    explanation: '"super" refers to the parent class — used to call its constructor or an overridden method.',
    syntax: 'super(); // calls the parent constructor',
    examples: [ex('class Animal {\n    Animal() { System.out.println("Animal made"); }\n}\nclass Dog extends Animal {\n    Dog() { super(); System.out.println("Dog made"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        new Dog();\n    }\n}', 'Animal made\nDog made')],
    important_points: ['If you don\'t call super() explicitly, Java calls the parent\'s no-argument constructor for you automatically.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Animal {\n    Animal() { System.out.println("Animal made"); }\n}\nclass Dog extends Animal {\n    Dog() { super(); System.out.println("Dog made"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        new Dog();\n    }\n}' },
    quickCheck({ text: 'What does super() call?', options: ["The subclass's own constructor", "The parent class's constructor", 'A static method', 'Nothing, it is invalid'], correct_index: 1 })),

  lesson(3, 'Method Overriding', 7, {
    explanation: 'A subclass can override a parent method by redefining it with the same signature — the subclass version runs instead.',
    syntax: '@Override\nvoid sound() { ... }',
    examples: [ex('class Animal {\n    void sound() { System.out.println("..."); }\n}\nclass Dog extends Animal {\n    @Override\n    void sound() { System.out.println("Bark"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Animal a = new Dog();\n        a.sound();\n    }\n}', 'Bark')],
    important_points: ['This is polymorphism: even though "a" is typed Animal, the Dog version runs because that\'s the real object.', '@Override is optional but helps the compiler catch typos in the method signature.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Animal {\n    void sound() { System.out.println("..."); }\n}\nclass Dog extends Animal {\n    @Override\n    void sound() { System.out.println("Bark"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Animal a = new Dog();\n        a.sound();\n    }\n}' },
    quickCheck({ text: 'If Dog overrides Animal\'s sound(), and Animal a = new Dog(); a.sound() runs...', options: ["Animal's version", "Dog's version", 'Both versions', 'A compile error'], correct_index: 1 })),

  lesson(4, 'Abstract Classes', 7, {
    explanation: 'An abstract class cannot be instantiated directly and can declare methods with no body (abstract methods) that subclasses must implement.',
    syntax: 'abstract class Shape {\n    abstract double area();\n}',
    examples: [ex('abstract class Shape {\n    abstract double area();\n}\nclass Circle extends Shape {\n    double r = 2;\n    double area() { return 3.14 * r * r; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Shape s = new Circle();\n        System.out.println(s.area());\n    }\n}', '12.56')],
    important_points: ['You cannot write "new Shape()" — only concrete (non-abstract) subclasses can be instantiated.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'abstract class Shape {\n    abstract double area();\n}\nclass Circle extends Shape {\n    double r = 2;\n    double area() { return 3.14 * r * r; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Shape s = new Circle();\n        System.out.println(s.area());\n    }\n}' },
    quickCheck({ text: 'Can you write "new Shape()" if Shape is abstract?', options: ['Yes, always', 'No — abstract classes cannot be instantiated', 'Only inside main()', 'Only with no fields'], correct_index: 1 })),

  lesson(5, 'Interfaces', 7, {
    explanation: 'An interface is a fully abstract contract — a class "implements" it and must provide real bodies for all its methods.',
    syntax: 'interface Flyable {\n    void fly();\n}\nclass Bird implements Flyable { ... }',
    examples: [ex('interface Flyable {\n    void fly();\n}\nclass Bird implements Flyable {\n    public void fly() { System.out.println("Flying"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Flyable f = new Bird();\n        f.fly();\n    }\n}', 'Flying')],
    important_points: ['A class can implement multiple interfaces, but can only extend one class.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'interface Flyable {\n    void fly();\n}\nclass Bird implements Flyable {\n    public void fly() { System.out.println("Flying"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Flyable f = new Bird();\n        f.fly();\n    }\n}' },
    quickCheck({ text: 'How many interfaces can one Java class implement?', options: ['Zero', 'Exactly one', 'One or more', 'Only if abstract'], correct_index: 2 }))
];

// ---------------------------------------------------------------------
// Module 6 — Collections (Intermediate)
// ---------------------------------------------------------------------
const M6 = [
  lesson(1, 'ArrayList', 7, {
    explanation: 'ArrayList is a resizable list — unlike an array, it can grow and shrink as you add or remove elements.',
    syntax: 'ArrayList<String> list = new ArrayList<>();\nlist.add("x");',
    examples: [ex('import java.util.ArrayList;\n\npublic class Main {\n    public static void main(String[] args) {\n        ArrayList<String> list = new ArrayList<>();\n        list.add("a");\n        list.add("b");\n        System.out.println(list.get(1));\n    }\n}', 'b')],
    important_points: ['<String> is a generic type — it means "this ArrayList only holds Strings."'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.ArrayList;\n\npublic class Main {\n    public static void main(String[] args) {\n        ArrayList<String> list = new ArrayList<>();\n        list.add("a");\n        list.add("b");\n        System.out.println(list.get(1));\n    }\n}' },
    quickCheck({ text: 'What is the main advantage of ArrayList over a plain array?', options: ['It is faster for math', 'It can resize dynamically', 'It cannot hold objects', 'It is always sorted'], correct_index: 1 })),

  lesson(2, 'HashMap', 7, {
    explanation: 'HashMap stores key → value pairs and gives fast lookup by key.',
    syntax: 'HashMap<String, Integer> ages = new HashMap<>();\nages.put("Sam", 20);',
    examples: [ex('import java.util.HashMap;\n\npublic class Main {\n    public static void main(String[] args) {\n        HashMap<String, Integer> ages = new HashMap<>();\n        ages.put("Sam", 20);\n        System.out.println(ages.get("Sam"));\n    }\n}', '20')],
    important_points: ['Keys are unique — putting a second value under the same key overwrites the first.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.HashMap;\n\npublic class Main {\n    public static void main(String[] args) {\n        HashMap<String, Integer> ages = new HashMap<>();\n        ages.put("Sam", 20);\n        System.out.println(ages.get("Sam"));\n    }\n}' },
    quickCheck({ text: 'A HashMap stores data as:', options: ['A single sorted list', 'Key-value pairs', 'A fixed-size array', 'Only Strings'], correct_index: 1 })),

  lesson(3, 'HashSet', 6, {
    explanation: 'HashSet stores a collection of unique values — adding a duplicate has no effect.',
    syntax: 'HashSet<Integer> nums = new HashSet<>();',
    examples: [ex('import java.util.HashSet;\n\npublic class Main {\n    public static void main(String[] args) {\n        HashSet<Integer> nums = new HashSet<>();\n        nums.add(5);\n        nums.add(5);\n        System.out.println(nums.size());\n    }\n}', '1')],
    important_points: ['Use a HashSet whenever you need "no duplicates allowed" instead of a List.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.HashSet;\n\npublic class Main {\n    public static void main(String[] args) {\n        HashSet<Integer> nums = new HashSet<>();\n        nums.add(5);\n        nums.add(5);\n        System.out.println(nums.size());\n    }\n}' },
    quickCheck({ text: 'After adding 5 twice to a HashSet, its size is:', options: ['0', '1', '2', 'Error'], correct_index: 1 })),

  lesson(4, 'Iterators', 6, {
    explanation: 'An Iterator walks through a collection one element at a time — hasNext() checks if there\'s more, next() returns the next value.',
    syntax: 'Iterator<String> it = list.iterator();\nwhile (it.hasNext()) { ... it.next() ... }',
    examples: [ex('import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        ArrayList<String> list = new ArrayList<>();\n        list.add("a"); list.add("b");\n        Iterator<String> it = list.iterator();\n        while (it.hasNext()) {\n            System.out.println(it.next());\n        }\n    }\n}', 'a\nb')],
    important_points: ['A for-each loop uses an Iterator internally — it is usually simpler to write when you don\'t need to remove elements while looping.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        ArrayList<String> list = new ArrayList<>();\n        list.add("a"); list.add("b");\n        Iterator<String> it = list.iterator();\n        while (it.hasNext()) {\n            System.out.println(it.next());\n        }\n    }\n}' },
    quickCheck({ text: 'What does it.hasNext() check?', options: ['If the list is empty', 'If there is another element to visit', 'If the list is sorted', 'If it is the first element'], correct_index: 1 })),

  lesson(5, 'Collections Practice', 8, {
    explanation: 'Practice combining an ArrayList with a loop to process a group of values.',
    syntax: '',
    examples: [ex('import java.util.ArrayList;\n\npublic class Main {\n    public static void main(String[] args) {\n        ArrayList<Integer> nums = new ArrayList<>();\n        nums.add(1); nums.add(2); nums.add(3);\n        int total = 0;\n        for (int n : nums) total += n;\n        System.out.println(total);\n    }\n}', '6')],
    important_points: [],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.ArrayList;\n\npublic class Main {\n    public static void main(String[] args) {\n        ArrayList<Integer> nums = new ArrayList<>();\n        nums.add(4); nums.add(5); nums.add(6);\n        // print the sum of nums\n    }\n}' },
    quickCheck({ type: 'code', text: 'Given an ArrayList<Integer> with 4, 5, 6, print their sum.', starter_code: 'import java.util.ArrayList;\n\npublic class Main {\n    public static void main(String[] args) {\n        ArrayList<Integer> nums = new ArrayList<>();\n        nums.add(4); nums.add(5); nums.add(6);\n        // print the sum\n    }\n}', test_cases: [{ input: '', expected_output: '15' }] }))
];

// ---------------------------------------------------------------------
// Module 7 — Exception Handling (Intermediate)
// ---------------------------------------------------------------------
const M7 = [
  lesson(1, 'try-catch', 7, {
    explanation: 'try-catch lets your program handle a runtime error gracefully instead of crashing.',
    syntax: 'try {\n    // risky code\n} catch (Exception e) {\n    // handle it\n}',
    examples: [ex('public class Main {\n    public static void main(String[] args) {\n        try {\n            int x = 10 / 0;\n        } catch (ArithmeticException e) {\n            System.out.println("Cannot divide by zero");\n        }\n    }\n}', 'Cannot divide by zero')],
    important_points: ['Without try-catch, an uncaught exception stops the whole program.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        try {\n            int x = 10 / 0;\n        } catch (ArithmeticException e) {\n            System.out.println("Cannot divide by zero");\n        }\n    }\n}' },
    quickCheck({ text: 'What happens to code in the catch block?', options: ['It always runs first', 'It runs only if the try block throws a matching exception', 'It never runs', 'It replaces the try block'], correct_index: 1 })),

  lesson(2, 'finally', 6, {
    explanation: 'A finally block runs after try/catch no matter what — whether an exception happened or not.',
    syntax: 'try { ... } catch (Exception e) { ... } finally { ... }',
    examples: [ex('public class Main {\n    public static void main(String[] args) {\n        try {\n            System.out.println("try");\n        } finally {\n            System.out.println("finally");\n        }\n    }\n}', 'try\nfinally')],
    important_points: ['finally is often used to close resources (files, connections) that must clean up regardless of errors.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        try {\n            System.out.println("try");\n        } finally {\n            System.out.println("finally");\n        }\n    }\n}' },
    quickCheck({ text: 'When does a finally block run?', options: ['Only if no exception occurred', 'Only if an exception occurred', 'Always, after try/catch', 'Never automatically'], correct_index: 2 })),

  lesson(3, 'throw', 6, {
    explanation: '"throw" lets you raise an exception yourself, on purpose, when something invalid happens.',
    syntax: 'throw new IllegalArgumentException("message");',
    examples: [ex('public class Main {\n    static void check(int age) {\n        if (age < 0) throw new IllegalArgumentException("Age cannot be negative");\n        System.out.println("OK: " + age);\n    }\n    public static void main(String[] args) {\n        check(20);\n    }\n}', 'OK: 20')],
    important_points: ['"throw" raises one exception; "throws" (in a method signature) declares that a method might throw one.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'public class Main {\n    static void check(int age) {\n        if (age < 0) throw new IllegalArgumentException("Age cannot be negative");\n        System.out.println("OK: " + age);\n    }\n    public static void main(String[] args) {\n        check(20);\n    }\n}' },
    quickCheck({ text: 'What does the "throw" keyword do?', options: ['Catches an exception', 'Raises an exception', 'Suppresses an exception', 'Deletes an exception'], correct_index: 1 })),

  lesson(4, 'Custom Exceptions', 7, {
    explanation: 'You can define your own exception type by extending Exception (or RuntimeException) to give errors a meaningful name.',
    syntax: 'class InvalidAgeException extends Exception {\n    InvalidAgeException(String m) { super(m); }\n}',
    examples: [ex('class InvalidAgeException extends RuntimeException {\n    InvalidAgeException(String m) { super(m); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        try {\n            throw new InvalidAgeException("Bad age");\n        } catch (InvalidAgeException e) {\n            System.out.println(e.getMessage());\n        }\n    }\n}', 'Bad age')],
    important_points: ['Extending RuntimeException means callers aren\'t forced to catch it; extending Exception means they are.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class InvalidAgeException extends RuntimeException {\n    InvalidAgeException(String m) { super(m); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        try {\n            throw new InvalidAgeException("Bad age");\n        } catch (InvalidAgeException e) {\n            System.out.println(e.getMessage());\n        }\n    }\n}' },
    quickCheck({ text: 'How do you create a custom exception type?', options: ['extends Exception (or RuntimeException)', 'implements Exception', 'new Exception.custom()', 'You cannot in Java'], correct_index: 0 }))
];

// ---------------------------------------------------------------------
// Module 8 — File Handling (Advanced)
// ---------------------------------------------------------------------
const M8 = [
  lesson(1, 'File Class', 6, {
    explanation: 'java.io.File represents a path on disk and lets you check things like whether it exists, without opening it.',
    syntax: 'File f = new File("data.txt");\nf.exists();',
    examples: [ex('import java.io.File;\n\npublic class Main {\n    public static void main(String[] args) {\n        File f = new File("data.txt");\n        System.out.println(f.getName());\n    }\n}', 'data.txt')],
    important_points: ['Creating a File object does not create the file on disk — it just represents the path.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.io.File;\n\npublic class Main {\n    public static void main(String[] args) {\n        File f = new File("data.txt");\n        System.out.println(f.getName());\n    }\n}' },
    quickCheck({ text: 'Does "new File(\\"data.txt\\")" create the file on disk?', options: ['Yes, immediately', 'No — it just represents the path', 'Only in test mode', 'Only if it already exists'], correct_index: 1 })),

  lesson(2, 'FileReader/Writer', 6, {
    explanation: 'FileReader and FileWriter read and write text files character by character.',
    syntax: 'FileWriter fw = new FileWriter("out.txt");\nfw.write("hello");\nfw.close();',
    examples: [ex('import java.io.FileWriter;\nimport java.io.IOException;\n\npublic class Main {\n    public static void main(String[] args) throws IOException {\n        FileWriter fw = new FileWriter("out.txt");\n        fw.write("hello");\n        fw.close();\n        System.out.println("written");\n    }\n}', 'written')],
    important_points: ['File operations can throw IOException, so the method signature needs "throws IOException" (or a try-catch).'],
    common_mistakes: ['Forgetting to close() the writer, which can leave data unflushed to disk.'],
    real_world: ''
  }, { starter_code: 'import java.io.FileWriter;\nimport java.io.IOException;\n\npublic class Main {\n    public static void main(String[] args) throws IOException {\n        FileWriter fw = new FileWriter("out.txt");\n        fw.write("hello");\n        fw.close();\n        System.out.println("written");\n    }\n}' },
    quickCheck({ text: 'Why must file-handling methods declare "throws IOException"?', options: ['Java requires it for style', 'File operations can fail and raise a checked exception', 'It makes code run faster', 'It is optional decoration'], correct_index: 1 })),

  lesson(3, 'BufferedReader', 6, {
    explanation: 'BufferedReader wraps another reader to read text efficiently, line by line.',
    syntax: 'BufferedReader br = new BufferedReader(new FileReader("data.txt"));\nString line = br.readLine();',
    examples: [ex('import java.io.*;\n\npublic class Main {\n    public static void main(String[] args) throws IOException {\n        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));\n        String line = br.readLine();\n        System.out.println("Read: " + line);\n    }\n}', 'Read: (whatever was typed)')],
    important_points: ['readLine() returns null when there is nothing left to read — a common loop-ending check.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.io.*;\n\npublic class Main {\n    public static void main(String[] args) throws IOException {\n        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));\n        String line = br.readLine();\n        System.out.println("Read: " + line);\n    }\n}' },
    quickCheck({ text: 'What does readLine() return when there is no more input?', options: ['An empty string', 'null', 'Throws an error always', '0'], correct_index: 1 }))
];

// ---------------------------------------------------------------------
// Module 9 — Multithreading (Advanced)
// ---------------------------------------------------------------------
const M9 = [
  lesson(1, 'Thread Basics', 7, {
    explanation: 'A Thread lets a block of code run concurrently with the rest of the program.',
    syntax: 'class MyThread extends Thread {\n    public void run() { ... }\n}\nnew MyThread().start();',
    examples: [ex('class MyThread extends Thread {\n    public void run() { System.out.println("Running"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        MyThread t = new MyThread();\n        t.start();\n    }\n}', 'Running')],
    important_points: ['Call .start() to run a thread concurrently — calling .run() directly just runs it like a normal method, on the same thread.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class MyThread extends Thread {\n    public void run() { System.out.println("Running"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        MyThread t = new MyThread();\n        t.start();\n    }\n}' },
    quickCheck({ text: 'Which method actually starts a new thread running concurrently?', options: ['.run()', '.start()', '.begin()', '.execute()'], correct_index: 1 })),

  lesson(2, 'Runnable', 6, {
    explanation: 'Runnable is an interface for "a task to run" — often preferred over extending Thread since a class can implement it and still extend something else.',
    syntax: 'class Task implements Runnable {\n    public void run() { ... }\n}\nnew Thread(new Task()).start();',
    examples: [ex('class Task implements Runnable {\n    public void run() { System.out.println("Task running"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Thread t = new Thread(new Task());\n        t.start();\n    }\n}', 'Task running')],
    important_points: ['Runnable separates "what to run" from "how to run it (a Thread)".'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Task implements Runnable {\n    public void run() { System.out.println("Task running"); }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Thread t = new Thread(new Task());\n        t.start();\n    }\n}' },
    quickCheck({ text: 'Why is implementing Runnable often preferred over extending Thread?', options: ['It runs faster', 'The class can still extend another class', 'Threads only work with Runnable', 'It avoids using .start()'], correct_index: 1 })),

  lesson(3, 'Synchronization', 7, {
    explanation: 'synchronized prevents two threads from running the same block of code on the same object at once, avoiding data corruption.',
    syntax: 'synchronized void increment() { count++; }',
    examples: [ex('class Counter {\n    int count = 0;\n    synchronized void increment() { count++; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Counter c = new Counter();\n        c.increment();\n        System.out.println(c.count);\n    }\n}', '1')],
    important_points: ['Without synchronization, two threads updating shared data at the same time can produce incorrect results ("race conditions").'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Counter {\n    int count = 0;\n    synchronized void increment() { count++; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Counter c = new Counter();\n        c.increment();\n        System.out.println(c.count);\n    }\n}' },
    quickCheck({ text: 'What problem does "synchronized" mainly protect against?', options: ['Slow disk reads', 'Two threads corrupting shared data at the same time', 'Compilation errors', 'Memory leaks'], correct_index: 1 }))
];

// ---------------------------------------------------------------------
// Module 10 — Generics (Advanced)
// ---------------------------------------------------------------------
const M10 = [
  lesson(1, 'Generic Methods', 6, {
    explanation: 'A generic method works with any type, decided when it is called, instead of one fixed type.',
    syntax: 'static <T> void printItem(T item) { System.out.println(item); }',
    examples: [ex('public class Main {\n    static <T> void printItem(T item) { System.out.println(item); }\n    public static void main(String[] args) {\n        printItem("hello");\n        printItem(42);\n    }\n}', 'hello\n42')],
    important_points: ['<T> is a placeholder type — Java fills it in based on the argument you pass.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'public class Main {\n    static <T> void printItem(T item) { System.out.println(item); }\n    public static void main(String[] args) {\n        printItem("hello");\n        printItem(42);\n    }\n}' },
    quickCheck({ text: 'What does <T> represent in a generic method?', options: ['A fixed type, always String', 'A placeholder type decided at the call site', 'A syntax error', 'A comment'], correct_index: 1 })),

  lesson(2, 'Generic Classes', 6, {
    explanation: 'A generic class can be parameterized with a type, so the same class works for different data types safely.',
    syntax: 'class Box<T> {\n    T value;\n}',
    examples: [ex('class Box<T> {\n    T value;\n    Box(T v) { value = v; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Box<String> b = new Box<>("hi");\n        System.out.println(b.value);\n    }\n}', 'hi')],
    important_points: ['Box<String> and Box<Integer> are both "Box", just specialized for different content types — no casting needed to read b.value.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Box<T> {\n    T value;\n    Box(T v) { value = v; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Box<String> b = new Box<>("hi");\n        System.out.println(b.value);\n    }\n}' },
    quickCheck({ text: 'What is the benefit of a generic class like Box<T>?', options: ['It only works with numbers', 'It reuses the same class safely for any type', 'It is required for all classes', 'It removes the need for constructors'], correct_index: 1 })),

  lesson(3, 'Bounded Types', 6, {
    explanation: 'A bounded type parameter restricts what T can be — e.g. <T extends Number> only allows numeric types.',
    syntax: 'static <T extends Number> double sum(T a, T b) { return a.doubleValue() + b.doubleValue(); }',
    examples: [ex('public class Main {\n    static <T extends Number> double sum(T a, T b) {\n        return a.doubleValue() + b.doubleValue();\n    }\n    public static void main(String[] args) {\n        System.out.println(sum(3, 4));\n    }\n}', '7.0')],
    important_points: ['"extends Number" here means "any subtype of Number" — it lets you call Number methods like doubleValue() on T.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'public class Main {\n    static <T extends Number> double sum(T a, T b) {\n        return a.doubleValue() + b.doubleValue();\n    }\n    public static void main(String[] args) {\n        System.out.println(sum(3, 4));\n    }\n}' },
    quickCheck({ text: 'What does <T extends Number> restrict T to?', options: ['Any type', 'Only Number and its subtypes', 'Only String', 'Only primitives'], correct_index: 1 }))
];

// ---------------------------------------------------------------------
// Module 11 — Advanced Java (Advanced)
// ---------------------------------------------------------------------
const M11 = [
  lesson(1, 'Lambda Expressions', 7, {
    explanation: 'A lambda expression is a short, inline way to write a function without a full method — commonly used with interfaces that have one method.',
    syntax: '(a, b) -> a + b',
    examples: [ex('import java.util.function.BinaryOperator;\n\npublic class Main {\n    public static void main(String[] args) {\n        BinaryOperator<Integer> add = (a, b) -> a + b;\n        System.out.println(add.apply(2, 3));\n    }\n}', '5')],
    important_points: ['Lambdas remove the boilerplate of writing a whole class just to implement one method.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.function.BinaryOperator;\n\npublic class Main {\n    public static void main(String[] args) {\n        BinaryOperator<Integer> add = (a, b) -> a + b;\n        System.out.println(add.apply(2, 3));\n    }\n}' },
    quickCheck({ text: 'What is the main purpose of a lambda expression?', options: ['Replace all loops', 'Write a short inline function without a full class', 'Only used for printing', 'A type of exception'], correct_index: 1 })),

  lesson(2, 'Streams', 7, {
    explanation: 'The Stream API processes collections in a pipeline of operations like filter and map, instead of manual loops.',
    syntax: 'list.stream().filter(x -> x > 2).forEach(System.out::println);',
    examples: [ex('import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Integer> nums = List.of(1, 2, 3, 4);\n        nums.stream().filter(n -> n % 2 == 0).forEach(System.out::println);\n    }\n}', '2\n4')],
    important_points: ['A stream doesn\'t store data itself — it describes a pipeline of operations applied to a source collection.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Integer> nums = List.of(1, 2, 3, 4);\n        nums.stream().filter(n -> n % 2 == 0).forEach(System.out::println);\n    }\n}' },
    quickCheck({ text: 'What does .filter() do in a stream pipeline?', options: ['Sorts the elements', 'Keeps only elements matching a condition', 'Removes the stream', 'Counts elements'], correct_index: 1 })),

  lesson(3, 'Optional', 6, {
    explanation: 'Optional<T> wraps a value that might be missing, forcing you to handle the "no value" case instead of risking a null pointer.',
    syntax: 'Optional<String> name = Optional.ofNullable(getName());\nname.orElse("Unknown");',
    examples: [ex('import java.util.Optional;\n\npublic class Main {\n    public static void main(String[] args) {\n        Optional<String> name = Optional.ofNullable(null);\n        System.out.println(name.orElse("Unknown"));\n    }\n}', 'Unknown')],
    important_points: ['orElse(default) returns the value if present, or the given default if it is empty.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.Optional;\n\npublic class Main {\n    public static void main(String[] args) {\n        Optional<String> name = Optional.ofNullable(null);\n        System.out.println(name.orElse("Unknown"));\n    }\n}' },
    quickCheck({ text: 'What is the main purpose of Optional<T>?', options: ['Speed up loops', 'Make "possibly missing" values explicit and safe', 'Replace all exceptions', 'Only for Strings'], correct_index: 1 }))
];

// ---------------------------------------------------------------------
// Module 12 — Java + Database (JDBC) (Advanced)
// ---------------------------------------------------------------------
const M12 = [
  lesson(1, 'JDBC Basics', 6, {
    explanation: 'JDBC (Java Database Connectivity) is the standard API Java uses to talk to relational databases like MySQL or PostgreSQL.',
    syntax: 'Connection conn = DriverManager.getConnection(url, user, password);',
    examples: [ex('// Conceptual — connecting requires a real database and driver on the classpath\nConnection conn = DriverManager.getConnection(\n    "jdbc:mysql://localhost:3306/school", "root", "password");', '(connects to the database)')],
    important_points: ['JDBC is the same API regardless of which database you connect to — only the connection URL and driver change.'],
    common_mistakes: [],
    real_world: ''
  }, null,
    quickCheck({ text: 'What does JDBC let a Java program do?', options: ['Render a UI', 'Connect to and query a relational database', 'Compile faster', 'Handle threads'], correct_index: 1 })),

  lesson(2, 'Connecting to a Database', 6, {
    explanation: 'A JDBC connection needs a URL (which database and where), a username, and a password.',
    syntax: 'DriverManager.getConnection("jdbc:mysql://host:port/db", user, pass);',
    examples: [ex('// jdbc:<database-type>://<host>:<port>/<database-name>\nString url = "jdbc:mysql://localhost:3306/school";', '')],
    important_points: ['Always close a Connection (or use try-with-resources) when you\'re done, so the database connection is released.'],
    common_mistakes: [],
    real_world: ''
  }, null,
    quickCheck({ text: 'Which three pieces does a basic JDBC connection typically need?', options: ['URL, username, password', 'Only a URL', 'Only a password', 'A file path'], correct_index: 0 })),

  lesson(3, 'CRUD Operations', 7, {
    explanation: 'CRUD (Create, Read, Update, Delete) operations in JDBC are run with SQL statements through a Statement or PreparedStatement.',
    syntax: 'PreparedStatement ps = conn.prepareStatement("INSERT INTO students(name) VALUES (?)");\nps.setString(1, "Sam");\nps.executeUpdate();',
    examples: [ex('// PreparedStatement avoids SQL injection by using placeholders (?)\nPreparedStatement ps = conn.prepareStatement("SELECT * FROM students WHERE id = ?");\nps.setInt(1, 5);', '')],
    important_points: ['Prefer PreparedStatement over building raw SQL strings — it protects against SQL injection.'],
    common_mistakes: [],
    real_world: ''
  }, null,
    quickCheck({ text: 'Why is PreparedStatement generally safer than a raw Statement?', options: ['It runs faster always', 'It protects against SQL injection using placeholders', 'It requires no database', 'It skips validation'], correct_index: 1 }))
];

// ---------------------------------------------------------------------
// Module 13 — Java + Data Structures (Advanced)
// ---------------------------------------------------------------------
const M13 = [
  lesson(1, 'Linked Lists', 7, {
    explanation: 'A linked list is a chain of nodes, each pointing to the next — Java\'s LinkedList class implements this ready-made.',
    syntax: 'LinkedList<Integer> list = new LinkedList<>();',
    examples: [ex('import java.util.LinkedList;\n\npublic class Main {\n    public static void main(String[] args) {\n        LinkedList<Integer> list = new LinkedList<>();\n        list.add(1);\n        list.addFirst(0);\n        System.out.println(list);\n    }\n}', '[0, 1]')],
    important_points: ['Unlike an array, a linked list has no fixed size and inserts at the front/back cheaply.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.LinkedList;\n\npublic class Main {\n    public static void main(String[] args) {\n        LinkedList<Integer> list = new LinkedList<>();\n        list.add(1);\n        list.addFirst(0);\n        System.out.println(list);\n    }\n}' },
    quickCheck({ text: 'What does addFirst() do on a LinkedList?', options: ['Adds to the end', 'Adds to the beginning', 'Removes the first item', 'Sorts the list'], correct_index: 1 })),

  lesson(2, 'Stacks', 6, {
    explanation: 'A stack is Last-In-First-Out (LIFO) — the last element pushed is the first one popped.',
    syntax: 'Deque<Integer> stack = new ArrayDeque<>();\nstack.push(1); stack.pop();',
    examples: [ex('import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Deque<Integer> stack = new ArrayDeque<>();\n        stack.push(1);\n        stack.push(2);\n        System.out.println(stack.pop());\n    }\n}', '2')],
    important_points: ['ArrayDeque is the modern recommended way to use a stack in Java (over the older Stack class).'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Deque<Integer> stack = new ArrayDeque<>();\n        stack.push(1);\n        stack.push(2);\n        System.out.println(stack.pop());\n    }\n}' },
    quickCheck({ text: 'What does a stack\'s pop() return?', options: ['The first element ever pushed', 'The most recently pushed element', 'A random element', 'Nothing'], correct_index: 1 })),

  lesson(3, 'Queues', 6, {
    explanation: 'A queue is First-In-First-Out (FIFO) — the first element added is the first one removed.',
    syntax: 'Queue<Integer> q = new LinkedList<>();\nq.offer(1); q.poll();',
    examples: [ex('import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Queue<Integer> q = new LinkedList<>();\n        q.offer(1);\n        q.offer(2);\n        System.out.println(q.poll());\n    }\n}', '1')],
    important_points: ['poll() removes and returns the head of the queue — the oldest element still waiting.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Queue<Integer> q = new LinkedList<>();\n        q.offer(1);\n        q.offer(2);\n        System.out.println(q.poll());\n    }\n}' },
    quickCheck({ text: 'A queue removes elements in which order?', options: ['Last in, first out', 'First in, first out', 'Random order', 'Sorted order'], correct_index: 1 })),

  lesson(4, 'Searching', 6, {
    explanation: 'Linear search checks every element one by one; binary search (on a sorted array) repeatedly halves the search range for speed.',
    syntax: 'Arrays.binarySearch(sortedArray, target);',
    examples: [ex('import java.util.Arrays;\n\npublic class Main {\n    public static void main(String[] args) {\n        int[] arr = {1, 3, 5, 7, 9};\n        System.out.println(Arrays.binarySearch(arr, 7));\n    }\n}', '3')],
    important_points: ['Binary search requires the array to already be sorted — it will give wrong results otherwise.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.Arrays;\n\npublic class Main {\n    public static void main(String[] args) {\n        int[] arr = {1, 3, 5, 7, 9};\n        System.out.println(Arrays.binarySearch(arr, 7));\n    }\n}' },
    quickCheck({ text: 'What must be true before you use binary search on an array?', options: ['It must be sorted', 'It must contain only Strings', 'It must have an even length', 'Nothing special'], correct_index: 0 })),

  lesson(5, 'Sorting', 6, {
    explanation: 'Arrays.sort() and Collections.sort() sort arrays and lists in ascending order using an efficient built-in algorithm.',
    syntax: 'Arrays.sort(arr);\nCollections.sort(list);',
    examples: [ex('import java.util.Arrays;\n\npublic class Main {\n    public static void main(String[] args) {\n        int[] arr = {5, 2, 8, 1};\n        Arrays.sort(arr);\n        System.out.println(Arrays.toString(arr));\n    }\n}', '[1, 2, 5, 8]')],
    important_points: ['You rarely need to hand-write a sorting algorithm in real code — the built-in sort is well-tested and fast.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.Arrays;\n\npublic class Main {\n    public static void main(String[] args) {\n        int[] arr = {5, 2, 8, 1};\n        Arrays.sort(arr);\n        System.out.println(Arrays.toString(arr));\n    }\n}' },
    quickCheck({ text: 'What order does Arrays.sort() produce by default?', options: ['Descending', 'Ascending', 'Random', 'Unchanged'], correct_index: 1 }))
];

// ---------------------------------------------------------------------
// Module 14 — DSA with Java (Advanced)
// ---------------------------------------------------------------------
const M14 = [
  lesson(1, 'Trees Basics', 7, {
    explanation: 'A tree is a hierarchy of nodes; a binary tree limits each node to at most two children (left and right).',
    syntax: 'class Node {\n    int value;\n    Node left, right;\n}',
    examples: [ex('class Node {\n    int value;\n    Node left, right;\n    Node(int v) { value = v; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Node root = new Node(10);\n        root.left = new Node(5);\n        System.out.println(root.left.value);\n    }\n}', '5')],
    important_points: ['The topmost node is the "root"; a node with no children is a "leaf".'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Node {\n    int value;\n    Node left, right;\n    Node(int v) { value = v; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Node root = new Node(10);\n        root.left = new Node(5);\n        System.out.println(root.left.value);\n    }\n}' },
    quickCheck({ text: 'In a binary tree, how many children can a node have at most?', options: ['One', 'Two', 'Three', 'Unlimited'], correct_index: 1 })),

  lesson(2, 'Graphs Basics', 7, {
    explanation: 'A graph is a set of nodes (vertices) connected by edges — often represented in code as a map from each node to its neighbors.',
    syntax: 'Map<Integer, List<Integer>> graph = new HashMap<>();',
    examples: [ex('import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Map<Integer, List<Integer>> graph = new HashMap<>();\n        graph.put(1, List.of(2, 3));\n        System.out.println(graph.get(1));\n    }\n}', '[2, 3]')],
    important_points: ['This style — a map from node to list of neighbors — is called an "adjacency list", the most common graph representation.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Map<Integer, List<Integer>> graph = new HashMap<>();\n        graph.put(1, List.of(2, 3));\n        System.out.println(graph.get(1));\n    }\n}' },
    quickCheck({ text: 'What is an "adjacency list" used for?', options: ['Sorting arrays', 'Representing which nodes connect to which in a graph', 'Storing file paths', 'Handling exceptions'], correct_index: 1 })),

  lesson(3, 'Problem Solving', 8, {
    explanation: 'Applying data structures to solve a small problem: count how many times each value appears in an array.',
    syntax: '',
    examples: [ex('import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        int[] arr = {1, 2, 2, 3, 1, 1};\n        Map<Integer, Integer> counts = new HashMap<>();\n        for (int n : arr) counts.put(n, counts.getOrDefault(n, 0) + 1);\n        System.out.println(counts.get(1));\n    }\n}', '3')],
    important_points: ['getOrDefault(key, 0) is a clean way to increment a counter without checking "does this key exist yet" manually.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        int[] arr = {4, 4, 5, 6, 4};\n        // count how many times 4 appears and print it\n    }\n}' },
    quickCheck({ type: 'code', text: 'Given int[] arr = {4,4,5,6,4}, print how many times 4 appears.', starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int[] arr = {4, 4, 5, 6, 4};\n        // print the count of 4\n    }\n}', test_cases: [{ input: '', expected_output: '3' }] }))
];

// ---------------------------------------------------------------------
// Module 15 — Real-world Projects (Advanced)
// ---------------------------------------------------------------------
const M15 = [
  lesson(1, 'Calculator', 8, {
    explanation: 'Build a simple calculator: read two numbers and an operator, then print the result — combining input, conditionals, and methods.',
    syntax: '',
    examples: [ex('public class Main {\n    static int calc(int a, int b, char op) {\n        if (op == \'+\') return a + b;\n        if (op == \'-\') return a - b;\n        return 0;\n    }\n    public static void main(String[] args) {\n        System.out.println(calc(4, 3, \'+\'));\n    }\n}', '7')],
    important_points: ['Breaking the logic into its own method (calc) keeps main() focused on input/output.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'public class Main {\n    static int calc(int a, int b, char op) {\n        if (op == \'+\') return a + b;\n        if (op == \'-\') return a - b;\n        return 0;\n    }\n    public static void main(String[] args) {\n        System.out.println(calc(10, 4, \'-\'));\n    }\n}' },
    quickCheck({ type: 'code', text: 'Extend the idea: write calc(a, b, op) supporting \'*\', then print calc(6, 7, \'*\').', starter_code: 'public class Main {\n    static int calc(int a, int b, char op) {\n        if (op == \'+\') return a + b;\n        if (op == \'-\') return a - b;\n        if (op == \'*\') return a * b;\n        return 0;\n    }\n    public static void main(String[] args) {\n        System.out.println(calc(6, 7, \'*\'));\n    }\n}', test_cases: [{ input: '', expected_output: '42' }] })),

  lesson(2, 'Student Management System', 9, {
    explanation: 'A student management system uses a class to model a Student and a collection to store many of them.',
    syntax: '',
    examples: [ex('import java.util.*;\n\nclass Student {\n    String name; int marks;\n    Student(String n, int m) { name = n; marks = m; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Student> students = new ArrayList<>();\n        students.add(new Student("Sam", 85));\n        System.out.println(students.get(0).name);\n    }\n}', 'Sam')],
    important_points: ['This pattern — a class for one record, a List for many — is the backbone of most small data-management programs.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'import java.util.*;\n\nclass Student {\n    String name; int marks;\n    Student(String n, int m) { name = n; marks = m; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Student> students = new ArrayList<>();\n        students.add(new Student("Sam", 85));\n        students.add(new Student("Ana", 92));\n        // print each student\'s name and marks\n    }\n}' },
    quickCheck({ text: 'Which combination is the standard pattern for managing many records?', options: ['One class per record + a List of them', 'Only static variables', 'Only a 2D array', 'A single String'], correct_index: 0 })),

  lesson(3, 'Library Management', 9, {
    explanation: 'A library system extends the student-management pattern: track Book records and mark them borrowed/returned with a boolean field.',
    syntax: '',
    examples: [ex('class Book {\n    String title; boolean borrowed = false;\n    Book(String t) { title = t; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Book b = new Book("Java 101");\n        b.borrowed = true;\n        System.out.println(b.title + " borrowed: " + b.borrowed);\n    }\n}', 'Java 101 borrowed: true')],
    important_points: ['A boolean field like "borrowed" is a simple, common way to model a two-state status.'],
    common_mistakes: [],
    real_world: ''
  }, { starter_code: 'class Book {\n    String title; boolean borrowed = false;\n    Book(String t) { title = t; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Book b = new Book("Java 101");\n        b.borrowed = true;\n        System.out.println(b.title + " borrowed: " + b.borrowed);\n    }\n}' },
    quickCheck({ text: 'What is a simple way to model a book\'s borrowed/available status?', options: ['A boolean field', 'A separate database only', 'A String comment', 'It cannot be modeled'], correct_index: 0 })),

  lesson(4, 'Final Java Project', 10, {
    explanation: 'Bring it together: classes, collections, and control flow to manage a small set of records end-to-end (add, list, search).',
    syntax: '',
    examples: [ex('import java.util.*;\n\nclass Item {\n    String name; Item(String n) { name = n; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Item> items = new ArrayList<>();\n        items.add(new Item("Pen"));\n        items.add(new Item("Book"));\n        for (Item i : items) {\n            if (i.name.equals("Book")) System.out.println("Found: " + i.name);\n        }\n    }\n}', 'Found: Book')],
    important_points: ['This is the same shape as most real CRUD apps: a model class, a collection, and loops/conditionals to add, list, and search.'],
    common_mistakes: [],
    real_world: 'This exact pattern — model class + List + loop — scales up directly into the JDBC-backed apps from Module 12.'
  }, { starter_code: 'import java.util.*;\n\nclass Item {\n    String name; Item(String n) { name = n; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Item> items = new ArrayList<>();\n        items.add(new Item("Pen"));\n        items.add(new Item("Book"));\n        items.add(new Item("Bag"));\n        // print only the item named "Bag"\n    }\n}' },
    quickCheck({ type: 'code', text: 'Given the Item list {Pen, Book, Bag}, print "Found: Bag" when you find it.', starter_code: 'import java.util.*;\n\nclass Item {\n    String name; Item(String n) { name = n; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Item> items = new ArrayList<>();\n        items.add(new Item("Pen"));\n        items.add(new Item("Book"));\n        items.add(new Item("Bag"));\n        // find "Bag" and print "Found: Bag"\n    }\n}', test_cases: [{ input: '', expected_output: 'Found: Bag' }] }))
];

module.exports = { M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, M15 };
