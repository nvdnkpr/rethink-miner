var db = require('./db'),
    r = require('rethinkdb'),
    Promise = require('bluebird');
//cache = require('memory-cache'),
//var cache_time = 12 * 60 * 60 * 60; // 12 hours in msecs

var Query = {
  name: null,
  query: null,
  fields: null,

  headers: function() {
    if (!this.headers_val) {
      q = eval(this.query);
      this.headers_val = db.rql(q.map(function(i) { return i.keys()} ).distinct().reduce(function(red, i) {return red.union(i)}))
        .then(function (result) {
          this.headers_val = result.getUnique();
          return this.headers_val;
        });
    }
    return this.headers_val;
  },

  distincts: function () {
    qm = eval(this.query);
    p = this.headers()
      .map(function (header) {
        q = qm.withFields(header).distinct();

        info = {};
        info.key = header;
        info.count = db.rql(q.count());
        info.distincts = db.rql(q.sample(10).orderBy(header)).map(function (item) {
          return item[header];
        });
        return Promise.props(info);
      });
    return p;
  },

  pageData: function(params, callback) {
    p = doQueryPromise(this.name, this.query, this.fields, params);
    return p.nodeify(callback);
  },

  save: function() {
    q = r.table('queries').insert({name: this.name, query: this.query, fields: this.fields});
    return db.rql(q)
  }
};

function namedQuery(name) {
  p = db.rql(r.table('queries').get(name))
    .then(function (result) {
      if (result === null) {
        err = new Error('No results found for query name "' + name + '"');
        throw err;
      } else {
        query = Query.objspawn({
          name: name,
          query: result.query,
          fields: result.fields,
        });

        return query;
      }
    });
  return p;
}

function namedQueryNew(name, queryCode, fields) {
  promise = new Promise(function (resolve, reject) {
    if (name && queryCode) {
      query = Query.objspawn({
        name: name,
        query: queryCode,
        fields: fields,
      });

      resolve(query);
    } else {
      err = new Error('query fields failed validation');
      reject(err);
    }
  });
  return promise;
}

function tableQuery(dbName, tableName) {
  query = Query.objspawn({
    name: 'Database "' + dbName + '" table "' + tableName + '"',
        query: 'r.db("' + dbName + '").table("' + tableName + '")',
        fields: null,
  });
  return Promise.cast(query);
}

function queriesList() {
  p = db.rql(r.db('rethink_miner').table('queries').orderBy('name'))
    .then(function (cursor) {
      toArray = Promise.promisify(cursor.toArray, cursor);
      return toArray();
    });
  return p;
}

function tableList() {
  p = db.rql(r.dbList())
    .map(function (dbName) {
      p = db.rql(r.db(dbName).tableList());
      return Promise.props({name: dbName, tables: p});
    });
  return p;
}

exports.queriesList = queriesList;
exports.namedQuery = namedQuery;
exports.namedQueryNew = namedQueryNew;
exports.tableQuery = tableQuery;
exports.tableList = tableList;

// Utilities
//
//

function unpack_object(result, headers, fields, unpack_field) {
  red = Object.keys(result[unpack_field]);
  red.forEach(function(field) {
    fields.push(function(f) {
      return f[unpack_field][field];
    });
    headers.push(field);
  });
  return [headers, fields];
}

function prepare_table(fields_list, results) {
  headers = [];
  fields = [];
  if (!fields_list) {
    result0 = results[0]
    fields = Object.keys(result0);
    headers = Object.keys(result0);
    if (fields.indexOf('reduction') != -1) {
      if (typeof(result0['reduction']) == 'object') {
        // This is a groupedMapReduce
        reduction_field = fields.indexOf('reduction');
        reduced_field = fields.splice(reduction_field, 1);
        reduced_header = headers.splice(reduction_field, 1);

        d = unpack_object(result0, headers, fields, 'reduction');
        headers = d[0];
        fields = d[1];
      } else if (typeof(result0['group']) == 'object') {
        // This is a groupBy
        group_field = fields.indexOf('group');
        grouped_field = fields.splice(group_field, 1);
        grouped_header = headers.splice(group_field, 1);

        d = unpack_object(result0, headers, fields, 'group');
        headers = d[0];
        fields = d[1];

        // Put the reduction at the end
        reduction_field = fields.indexOf('reduction');
        reduced_field = fields.splice(reduction_field, 1);
        reduced_header = headers.splice(reduction_field, 1);

        fields.push(reduced_field[0]);
        headers.push(reduced_header[0]);
      }

    }
  } else {
    fields_list.forEach(function(field) {
      fields.push(field[0]);
      headers.push(field[1]);
    });
  }
  return [headers, fields];
}

function doQueryPromise(queryName, query, fields_list, params) {
  order_by = params.order_by || null;
  page_size = params.page_size || 100;
  page_num = params.page_num || 0;
  useOutdated = !params.force_uptodate;
  //TODO: make useOutdated work again: run_opts = {connection:conn, useOutdated:useOutdated};

  if (order_by && query) {
    query += ".orderBy('" + order_by + "')"
  }

  q = eval(query);

  if (!page_num) {
    page_num = 0;
  }

  start_index = page_num * page_size;

  promise_count = db.rql(q.count());
  promise_page = db.rql(q.skip(start_index).limit(page_size))
    .then(function (cursor) {
      if (typeof(cursor) == 'object') {
        toArray = Promise.promisify(cursor.toArray, cursor);
        return toArray();
      } else {
        return cursor;
      }
    });

  p = Promise.all([promise_count, promise_page])
    .then(function(results) {
      count = results[0];
      results = results[1];
      last_page = 0;
      if (count > page_size) {
        last_page = Math.floor((count + page_size - 1)  / page_size) - 1;
      }
      if (typeof(results) == 'object') {
        d = prepare_table(fields_list, results);
        headers = d[0];
        fields = d[1];
        entries = [];
        results.forEach(function(res) {
          entry = [];
          fields.forEach(function(field) {
            if (typeof field == "string") {
              entry.push(res[field]);
            } else {
              entry.push(field(res));
            }
          });
          entries.push(entry);
        });
      } else {
        headers = ['result'];
        entries = [[results]];
        count = 1;
      }
      return {'result': {
        'name': queryName,
          'query': query,
          'headers':headers,
          'res': entries,
          'order': order_by,
          'page_num': page_num,
          'page_size': page_size,
          'last_page': last_page,
          'count': count
      }};
    });
  return p;
}

Object.defineProperty(Object.prototype, "objspawn", {value: function (props) {
  var defs = {}, key;
  for (key in props) {
    if (props.hasOwnProperty(key)) {
      defs[key] = {value: props[key], enumerable: true};
    }
  }
  return Object.create(this, defs);
}});
