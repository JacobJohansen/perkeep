/*
Copyright 2013 The Camlistore Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Package kvfile implements the Camlistore index storage abstraction
// on top of a single mutable database file on disk using
// github.com/cznic/kv.
package kvfile

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sync"

	"camlistore.org/pkg/blobserver"
	"camlistore.org/pkg/index"
	"camlistore.org/pkg/jsonconfig"
	"camlistore.org/pkg/sorted"
	"camlistore.org/third_party/github.com/camlistore/lock"
	"camlistore.org/third_party/github.com/cznic/kv"
)

func init() {
	blobserver.RegisterStorageConstructor("kvfileindexer",
		blobserver.StorageConstructor(newFromConfig))
}

func NewStorage(file string) (sorted.KeyValue, error) {
	createOpen := kv.Open
	if _, err := os.Stat(file); os.IsNotExist(err) {
		createOpen = kv.Create
	}
	db, err := createOpen(file, &kv.Options{
		Locker: func(dbname string) (io.Closer, error) {
			lkfile := dbname + ".lock"
			cl, err := lock.Lock(lkfile)
			if err != nil {
				return nil, fmt.Errorf("failed to acquire lock on %s: %v", lkfile, err)
			}
			return cl, nil
		},
	})
	if err != nil {
		return nil, err
	}
	is := &kvis{
		db:   db,
		path: file,
	}
	return is, nil
}

type kvis struct {
	path string
	db   *kv.DB
	txmu sync.Mutex
}

// TODO: use bytepool package.
func getBuf(n int) []byte { return make([]byte, n) }
func putBuf([]byte)       {}

func (is *kvis) Get(key string) (string, error) {
	buf := getBuf(200)
	defer putBuf(buf)
	val, err := is.db.Get(buf, []byte(key))
	if err != nil {
		return "", err
	}
	if val == nil {
		return "", sorted.ErrNotFound
	}
	return string(val), nil
}

func (is *kvis) Set(key, value string) error {
	return is.db.Set([]byte(key), []byte(value))
}

func (is *kvis) Delete(key string) error {
	return is.db.Delete([]byte(key))
}

func (is *kvis) Find(start, end string) sorted.Iterator {
	it := &iter{
		db:       is.db,
		startKey: start,
		endKey:   []byte(end),
	}
	it.enum, _, it.err = it.db.Seek([]byte(start))
	return it
}

func (is *kvis) BeginBatch() sorted.BatchMutation {
	return sorted.NewBatchMutation()
}

type batch interface {
	Mutations() []sorted.Mutation
}

func (is *kvis) CommitBatch(bm sorted.BatchMutation) error {
	b, ok := bm.(batch)
	if !ok {
		return errors.New("invalid batch type")
	}
	is.txmu.Lock()
	defer is.txmu.Unlock()

	good := false
	defer func() {
		if !good {
			is.db.Rollback()
		}
	}()

	if err := is.db.BeginTransaction(); err != nil {
		return err
	}
	for _, m := range b.Mutations() {
		if m.IsDelete() {
			if err := is.db.Delete([]byte(m.Key())); err != nil {
				return err
			}
		} else {
			if err := is.db.Set([]byte(m.Key()), []byte(m.Value())); err != nil {
				return err
			}
		}
	}

	good = true
	return is.db.Commit()
}

func (is *kvis) Close() error {
	log.Printf("Closing kvfile database %s", is.path)
	return is.db.Close()
}

type iter struct {
	db       *kv.DB
	startKey string
	endKey   []byte

	enum *kv.Enumerator

	valid      bool
	key, val   []byte
	skey, sval *string // non-nil if valid

	err    error
	closed bool
}

func (it *iter) Close() error {
	it.closed = true
	return it.err
}

func (it *iter) KeyBytes() []byte {
	if !it.valid {
		panic("not valid")
	}
	return it.key
}

func (it *iter) Key() string {
	if !it.valid {
		panic("not valid")
	}
	if it.skey != nil {
		return *it.skey
	}
	str := string(it.key)
	it.skey = &str
	return str
}

func (it *iter) ValueBytes() []byte {
	if !it.valid {
		panic("not valid")
	}
	return it.val
}

func (it *iter) Value() string {
	if !it.valid {
		panic("not valid")
	}
	if it.sval != nil {
		return *it.sval
	}
	str := string(it.val)
	it.sval = &str
	return str
}

func (it *iter) end() bool {
	it.valid = false
	it.closed = true
	return false
}

func (it *iter) Next() (ret bool) {
	if it.err != nil {
		return false
	}
	if it.closed {
		panic("Next called after Next returned value")
	}
	it.skey, it.sval = nil, nil
	var err error
	it.key, it.val, err = it.enum.Next()
	if err == io.EOF {
		it.err = nil
		return it.end()
	}
	if err != nil {
		it.err = err
		return it.end()
	}
	if len(it.endKey) > 0 && bytes.Compare(it.key, it.endKey) >= 0 {
		return it.end()
	}
	it.valid = true
	return true
}

func init() {
	sorted.RegisterKeyValue("kv", newKeyValueFromConfig)
}

func newKeyValueFromConfig(cfg jsonconfig.Obj) (sorted.KeyValue, error) {
	file := cfg.RequiredString("file")
	if file == "" {
		return nil, errors.New("Missing 'file' parameter")
	}
	return NewStorage(file)
}

func newFromConfig(ld blobserver.Loader, config jsonconfig.Obj) (blobserver.Storage, error) {
	blobPrefix := config.RequiredString("blobSource")
	file := config.RequiredString("file")
	if err := config.Validate(); err != nil {
		return nil, err
	}

	is, err := NewStorage(file)
	if err != nil {
		return nil, err
	}

	sto, err := ld.GetStorage(blobPrefix)
	if err != nil {
		is.Close()
		return nil, err
	}

	ix := index.New(is)
	if err != nil {
		return nil, err
	}
	ix.BlobSource = sto

	// Good enough, for now:
	ix.KeyFetcher = ix.BlobSource

	return ix, err
}
