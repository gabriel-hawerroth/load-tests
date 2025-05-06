package main

import (
	"database/sql"
	"flag" // Added import for flag package
	"fmt"
	"time" // Added import for time package

	configs "github.com/gabriel-hawerroth/increase-db-script/config"
	"github.com/gabriel-hawerroth/increase-db-script/repositories"
	"github.com/gabriel-hawerroth/increase-db-script/services"
	_ "github.com/lib/pq"
)

var confs *configs.Conf

func main() {
	confs = loadConfigs()

	// Define and parse command-line flags
	deleteOnly := flag.Bool("delete", false, "If true, only delete releases for the user_id specified in .env")
	flag.Parse()

	db := openDatabaseConnection()
	defer db.Close()

	startProcess(db, *deleteOnly) // Pass the deleteOnly flag value
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

func startProcess(db *sql.DB, deleteOnly bool) { // Added deleteOnly parameter
	repository := repositories.NewRepository(db)

	if deleteOnly {
		fmt.Printf("Attempting to delete releases for UserID: %d\n", confs.UserID)
		startTime := time.Now() // Record start time
		err := repository.DeleteReleasesByUserID(confs.UserID)
		checkError(err)
		duration := time.Since(startTime)                                                          // Calculate duration
		fmt.Printf("Successfully deleted releases for UserID: %d in %s\n", confs.UserID, duration) // Log duration
		return                                                                                     // Exit after deletion
	}

	service := services.NewService(*repository, confs.TotalInserts, confs.UserID)

	fmt.Println("Starting process to generate and insert releases...")
	processStartTime := time.Now() // Record start time for the whole generation and insertion process
	service.Process()
	processDuration := time.Since(processStartTime)                                       // Calculate duration for the whole process
	fmt.Printf("Full generation and insertion process finished in %s\n", processDuration) // Log total duration for the process
}

func checkError(err error) {
	if err != nil {
		panic(err)
	}
}
