var r = require('rethinkdb'),
    debug = require('debug')('rdb'),
    csv = require('express-csv'),
    self = this;


/*
 * GET home page.
 */

exports.index = function(req, res){
  r.table('queries').run(self.connection, function(err, cursor) {
    if (err) {
      debug("[ERROR] %s:%s\n%s", err.name, err.msg, err.message);
      res.status(500);
      res.render('error', {title: 'Error querying db', description:err});
      return;
    }
    cursor.toArray(function(err, results) {
      if(err) {
        debug("[ERROR] %s:%s\n%s", err.name, err.msg, err.message);
        res.status(500);
        res.render('error', {title: 'No results', description: err});
      }
      else{
        res.render('index', {title: 'Known Queries', res: results});
      }
    });
  });
};

function unpack_object(result, headers, fields, unpack_field) {
  red = Object.keys(result[unpack_field]);
  red.forEach(function(field) {
    fields.push(function(f) {
      return f[unpack_field][field];
    });
    headers.push(field);
  });
  console.log('unpack');
  console.log(headers);
  console.log(fields);
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
  console.log(headers);
  return [headers, fields];
}

function query_result_object(cursor, queryName, query, fields_list, order_by, cb) {
  cursor.toArray(function(err, results) {
    if (err) {
      debug("[ERROR] %s:%s\n%s", err.name, err.msg, err.message);
      return cb(err, {title: 'Failed to convert query to array', description:err});
    } else {
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
      cb(null, {'result': {'name': queryName, 'query': query, 'headers':headers, 'res': entries, 'order': order_by}});
    }
  });
}

function doQuery(queryName, query, fields_list, order_by, cb) {
    try {
      if (order_by && query) {
        query += ".orderBy('" + order_by + "')"
      }

      q = eval(query);

      q.run(self.connection, function(err, cursor) {
        if (err) {
          return cb(err, {title: 'Failed to run user query', description: err});
        }
        if (typeof(cursor) == 'object') {
          query_result_object(cursor, queryName, query, fields_list, order_by, cb);
        } else {
          cb(null, {'result': {'name': queryName, 'query': query, 'headers':['result'], 'res': [[cursor]], 'order': ''}});
        }
      });
    }
    catch (e) {
      return cb(e, {title: 'Failed to run query', description: e.toString()})
    }
}

function doQueryByName(queryName, order_by, cb) {
  r.table('queries').get(queryName).run(self.connection, function(err, result) {
    if (err) {
      return cb(err, {title: 'Error querying database', description: err});
    }
    if (result === null) {
      s = 'No results found for query "' + queryName + '"';
      return cb(new Error(s), {title: s});
    }
    query = result.query;
    fields_list = result.fields;

    doQuery(queryName, query, fields_list, order_by, cb);
  });
}

exports.q = function(req, res) {
  doQueryByName(req.params.name, req.query.order,
      function(err, response) {
        if (err) {
          res.status(500);
          res.render('error', response);
          return;
        }

        if (req.query.format == 'csv') {
          answer = [response.result.headers].concat(response.result.res);
          console.log(answer);
          res.csv(answer);
        } else {
          res.render('query', response);
        }
      }
  );
};

exports.addShow = function (req, res) {
  res.render('add', null);
}

function addSave(req, res) {
  name = req.body.name;
  query = req.body.query;
  if (name && query) {
    r.table('queries').insert({name: name, query: query}).run(self.connection, function(err, result) {
      if (err) {
        return res.render('add', {name: name, query: query, msg: 'Save failed with error: ' + err});
      } else if (result.inserted > 0) {
        return res.render('add', {name: name, query: query, msg: 'Saved'});
      } else {
        return res.render('add', {name: name, query: query, msg: 'Failed to save for: ' + result.first_error});
      }
    });
  } else {
    return res.render('add', {name: name, query: query, msg: 'fields failed validation'});
  }
}

function addTest(req, res) {
  name = req.body.name;
  query = req.body.query;
  if (name && query) {
    doQuery('Testing ' + name, query, null, null, function(err, result) {
      if (err) {
        // TODO: Need to output the error here
        res.render('add', {name: name, query: query, msg: err});
      }

      console.log(result); //TODO: remove debug print
      res.render('add', result);
    });
  } else {
    res.render('add', {name: name, query: query, msg: 'Fields failed validation'});
  }
}

exports.addSaveOrTest = function (req, res) {
  if (req.body.action == 'Save') {
    return addSave(req, res);
  } else if (req.body.action == 'Test') {
    return addTest(req, res);
  } else {
    res.status(404);
    res.render('error', {title: 'Unknown action in add'});
  }
}

function test_data() {
  return [
  {
    'serial': 'DISK1',
    'temperature': 28,
    'reallocations': 0
  },
  {
    'serial': 'DISK2',
    'temperature': 38,
    'reallocations': 20
  },
  {
    'serial': 'DISK3',
    'temperature': 25,
    'reallocations': 120
  },
  {
    'serial': 'DISK4',
    'temperature': 25,
    'reallocations': 72
  },
  {
    'serial': 'DISK5',
    'temperature': 28,
    'reallocations': 4096
  },
  {
    'serial': 'DISK6',
    'temperature': 42,
    'reallocations': 1
  },
  {
    'serial': 'DISK7',
    'temperature': 27,
    'reallocations': 1025
  },
  {
    'serial': 'DISK8',
    'temperature': 14,
    'reallocations': 2
  },
  {
    'serial': 'DISK9',
    'temperature': 33,
    'reallocations': 190
  }
  ];
}

function test_queries() {
  return [
  {
    'name': 'Temperature Average',
    'query': "r.db('rethink_miner').table('test').pluck('temperature').avg()"
  },
  ];
}

exports.setupDB = function (conn, dbName) {
  r.dbCreate(dbName).run(conn, function(err, result) {
    r.db(dbName).tableCreate('queries', {primaryKey: 'name'}).run(conn, function(err, result) {
      if (result && result.created === 1) {
        r.db(dbName).tableCreate('test').run(conn, function(err, result) {
          r.db(dbName).table('test').insert(test_data()).run(conn, function(err, result) {
            if (result) {
              debug("Inserted %s sample test entries into table 'test' in db '%s'", result.inserted, dbName);
            }
          });
          r.db(dbName).table('queries').insert(test_queries()).run(conn, function(err, result) {
            if (result) {
              debug("Inserted %s sample queries into table 'queries' in db '%s'", result.inserted, dbName);
            }
          });
        });
      }
    });
  });
};
