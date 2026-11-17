'use strict';

/**
 * restore-dependency-graph.cjs
 *
 * Implements a directed dependency graph for database objects (tables, views,
 * routines, triggers, events) to compute safe topological restoration and
 * reverse drop orders, detect cyclic dependencies, and validate object selections.
 *
 * Design Pattern: Directed Acyclic Graph (DAG) with Kahn's Algorithm & DFS Cycle Detection.
 */

const OBJECT_TYPES = ['table', 'view', 'function', 'procedure', 'trigger', 'event'];

const TYPE_PRIORITY = {
  table: 1,
  function: 2,
  view: 3,
  procedure: 4,
  trigger: 5,
  event: 6
};

class RestoreDependencyGraph {
  constructor() {
    this.nodes = new Map(); // key -> { id, name, type, schema, metadata }
    this.edges = new Map(); // fromKey -> Set of toKeys (from depends on to)
    this.reverseEdges = new Map(); // toKey -> Set of fromKeys (to is depended on by from)
  }

  static nodeKey(type, name, schema = null) {
    const cleanType = String(type || '').toLowerCase();
    const cleanName = String(name || '').toLowerCase();
    const cleanSchema = schema ? String(schema).toLowerCase() : null;
    return cleanSchema ? `${cleanType}:${cleanSchema}.${cleanName}` : `${cleanType}:${cleanName}`;
  }

  addNode({ id, type, name, schema = null, metadata = {} }) {
    if (!type || !name) throw new Error('Object type and name are required to register a dependency graph node.');
    const key = id || RestoreDependencyGraph.nodeKey(type, name, schema);
    if (!this.nodes.has(key)) {
      this.nodes.set(key, {
        id: key,
        name: String(name),
        type: String(type).toLowerCase(),
        schema: schema ? String(schema) : null,
        metadata: { ...metadata }
      });
      this.edges.set(key, new Set());
      this.reverseEdges.set(key, new Set());
    } else {
      // Merge metadata if node was previously added
      const existing = this.nodes.get(key);
      Object.assign(existing.metadata, metadata);
    }
    return key;
  }

  hasNode(key) {
    return this.nodes.has(key);
  }

  getNode(key) {
    return this.nodes.get(key) || null;
  }

  addEdge(fromKey, toKey) {
    if (fromKey === toKey) return; // Self-loops are handled in cycle detection
    if (!this.nodes.has(fromKey) || !this.nodes.has(toKey)) return;
    this.edges.get(fromKey).add(toKey);
    this.reverseEdges.get(toKey).add(fromKey);
  }

  getDependencies(key) {
    const deps = this.edges.get(key);
    return deps ? Array.from(deps) : [];
  }

  getDependents(key) {
    const rev = this.reverseEdges.get(key);
    return rev ? Array.from(rev) : [];
  }

  /**
   * Detects all elementary cycles using Depth-First Search (DFS) with recursion stack.
   * Returns an array of cycle paths, e.g. [['table:a', 'table:b', 'table:a']].
   */
  detectCycles(scopeKeys = null) {
    const keys = scopeKeys ? Array.from(scopeKeys).filter(k => this.nodes.has(k)) : Array.from(this.nodes.keys());
    const visited = new Set();
    const inStack = new Set();
    const stack = [];
    const cycles = [];

    const dfs = (current) => {
      visited.add(current);
      inStack.add(current);
      stack.push(current);

      const targets = this.edges.get(current) || new Set();
      // Sort for deterministic traversal order
      const sortedTargets = Array.from(targets).sort();

      for (const target of sortedTargets) {
        if (scopeKeys && !scopeKeys.has(target)) continue;
        if (!visited.has(target)) {
          dfs(target);
        } else if (inStack.has(target)) {
          // Cycle detected: slice the cycle path from the stack
          const cycleStartIndex = stack.indexOf(target);
          if (cycleStartIndex !== -1) {
            const cyclePath = stack.slice(cycleStartIndex).concat(target);
            cycles.push(cyclePath);
          }
        }
      }

      stack.pop();
      inStack.delete(current);
    };

    for (const key of keys.sort()) {
      if (!visited.has(key)) {
        dfs(key);
      }
    }

    return cycles;
  }

  /**
   * Topological sort of nodes (or a subset of nodes) adhering to object type hierarchies
   * and foreign key / view dependencies.
   *
   * Ordering Strategy:
   * 1. Partition by object type priority:
   *    - tables (topologically sorted by FKs)
   *    - functions (topologically sorted if functions call functions)
   *    - views (topologically sorted by view->view and view->table dependencies)
   *    - procedures (topologically sorted by routine dependencies)
   *    - triggers (depend on their base tables)
   *    - events (last)
   * 2. Within each type partition, Kahn's algorithm resolves inter-dependencies.
   */
  topologicalSort(subsetKeys = null) {
    const activeKeys = new Set(
      subsetKeys ? Array.from(subsetKeys).filter(k => this.nodes.has(k)) : this.nodes.keys()
    );

    const cycles = this.detectCycles(activeKeys);

    // Group active keys by object type
    const byType = new Map();
    for (const type of OBJECT_TYPES) byType.set(type, []);

    for (const key of activeKeys) {
      const node = this.nodes.get(key);
      if (node && byType.has(node.type)) {
        byType.get(node.type).push(key);
      }
    }

    const order = [];
    const unresolved = new Set();

    // Helper: Run Kahn's algorithm on a specific set of keys
    const sortGroup = (groupKeys, allowedTargetTypes = null) => {
      const remaining = new Set(groupKeys);
      const inDegree = new Map();

      for (const key of groupKeys) {
        let count = 0;
        const deps = this.edges.get(key) || new Set();
        for (const dep of deps) {
          if (!activeKeys.has(dep)) continue;
          const depNode = this.nodes.get(dep);
          // If allowedTargetTypes is specified, only count dependencies of those types
          if (allowedTargetTypes && depNode && !allowedTargetTypes.includes(depNode.type)) continue;
          if (groupKeys.includes(dep)) {
            count++;
          }
        }
        inDegree.set(key, count);
      }

      while (remaining.size > 0) {
        // Deterministic candidate selection: 0 in-degree, sorted alphabetically by name
        const ready = Array.from(remaining)
          .filter(k => inDegree.get(k) === 0)
          .sort((a, b) => {
            const na = this.nodes.get(a)?.name || a;
            const nb = this.nodes.get(b)?.name || b;
            return na.localeCompare(nb);
          });

        if (ready.length === 0) {
          // Cycle or unresolvable inter-dependency within group
          for (const k of remaining) unresolved.add(k);
          break;
        }

        for (const key of ready) {
          order.push(key);
          remaining.delete(key);

          // Decrement in-degree for dependents in this group
          const dependents = this.reverseEdges.get(key) || new Set();
          for (const dep of dependents) {
            if (remaining.has(dep)) {
              inDegree.set(dep, Math.max(0, (inDegree.get(dep) || 1) - 1));
            }
          }
        }
      }
    };

    // 1. Sort Tables: only consider dependencies between tables (FKs)
    sortGroup(byType.get('table'), ['table']);

    // 2. Sort Functions: functions can be called by views or procedures
    sortGroup(byType.get('function'), ['function', 'table']);

    // 3. Sort Views: views can depend on tables and other views
    sortGroup(byType.get('view'), ['table', 'view', 'function']);

    // 4. Sort Procedures: procedures can depend on tables, views, functions, procedures
    sortGroup(byType.get('procedure'), ['table', 'view', 'function', 'procedure']);

    // 5. Sort Triggers: triggers depend on their base table
    sortGroup(byType.get('trigger'), ['table', 'view', 'function', 'procedure']);

    // 6. Sort Events: events depend on routines/tables
    sortGroup(byType.get('event'), ['table', 'view', 'function', 'procedure']);

    return {
      order,
      unresolved: Array.from(unresolved).sort(),
      cycles,
      hasCycles: cycles.length > 0
    };
  }

  /**
   * Computes reverse topological order for dropping objects safely.
   * Dependents are dropped before their dependencies (e.g. child tables before parent tables,
   * views before underlying tables, triggers before tables, etc.).
   */
  computeDropOrder(subsetKeys = null) {
    const { order, unresolved, cycles } = this.topologicalSort(subsetKeys);
    // Reverse the topological order so dependents come first
    const dropOrder = [...order].reverse();
    return {
      dropOrder,
      unresolved,
      cycles,
      hasCycles: cycles.length > 0
    };
  }

  /**
   * Validates whether all dependencies of selected objects are satisfied within the selection
   * or target database facts.
   */
  validateSelection(selectedKeys, availableTargetKeys = new Set()) {
    const selected = new Set(selectedKeys);
    const missing = [];
    const satisfied = [];

    for (const key of selected) {
      const deps = this.edges.get(key) || new Set();
      for (const dep of deps) {
        if (!selected.has(dep) && !availableTargetKeys.has(dep)) {
          missing.push({
            consumerKey: key,
            consumer: this.nodes.get(key),
            requiredDependencyKey: dep,
            requiredDependency: this.nodes.get(dep) || { id: dep, name: dep, type: 'unknown' }
          });
        } else {
          satisfied.push({ consumerKey: key, dependencyKey: dep });
        }
      }
    }

    return {
      valid: missing.length === 0,
      missingDependencies: missing,
      satisfiedDependencies: satisfied
    };
  }
}

module.exports = {
  RestoreDependencyGraph,
  OBJECT_TYPES,
  TYPE_PRIORITY
};
