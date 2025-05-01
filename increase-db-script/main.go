package main

import (
	"database/sql"
	"fmt"

	configs "github.com/gabriel-hawerroth/increase-db-script/config"
	"github.com/gabriel-hawerroth/increase-db-script/repositories"
	"github.com/gabriel-hawerroth/increase-db-script/services"
	_ "github.com/lib/pq"
)

var confs *configs.Conf

func main() {
	confs = loadConfigs()

	db := openDatabaseConnection()
	defer db.Close()

	startProcess(db)
}

func loadConfigs() *configs.Conf {
	confs, err := configs.LoadConfig(".")
	checkError(err)
	return confs
}

func openDatabaseConnection() *sql.DB {
	db, err := sql.Open("postgres", fmt.Sprintf("user=%s password=%s dbname=%s host=%s port=%s sslmode=disable", confs.DBUser, confs.DBPassword, confs.DBName, confs.DBHost, confs.DBPort))
	checkError(err)

	err = db.Ping()
	checkError(err)

	println("Connected to the database successfully")

	return db
}

func startProcess(db *sql.DB) {
	repository := repositories.NewRepository(db)
	service := services.NewService(*repository)

	service.Process()
}

func checkError(err error) {
	if err != nil {
		panic(err)
	}
}
