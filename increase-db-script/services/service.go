package services

import (
	"fmt"
	"math/big"
	"math/rand"
	"strconv"
	"time"

	"github.com/gabriel-hawerroth/increase-db-script/models"
	"github.com/gabriel-hawerroth/increase-db-script/repositories"
)

type Service struct {
	Repository   repositories.Repository
	TotalInserts int
	UserID       int
}

func NewService(repository repositories.Repository, totalInserts int, userID int) *Service {
	return &Service{
		Repository:   repository,
		TotalInserts: totalInserts,
		UserID:       userID,
	}
}

var (
	accounts   []int
	categories []int
)

func (s *Service) Process() {
	s.getAccounts(s.UserID)
	if len(accounts) == 0 {
		fmt.Println("Nenhuma conta encontrada, abortando.")
		return
	}
	fmt.Printf("Contas carregadas: %v\n", accounts)

	s.getCategories(s.UserID)
	if len(categories) == 0 {
		fmt.Println("Nenhuma categoria encontrada, abortando.")
		return
	}
	fmt.Printf("Categorias carregadas: %v\n", categories)

	releasesToInsert := make([]models.Release, 0, s.TotalInserts)

	today := time.Now()
	endDate := today.AddDate(0, 0, 20)
	startDate := endDate.AddDate(0, -6, 0)
	dateRangeSeconds := endDate.Unix() - startDate.Unix()

	fmt.Printf("Gerando %d lançamentos para o usuário %d\n", s.TotalInserts, s.UserID)
	for i := range s.TotalInserts {
		description := "Lançamento " + strconv.Itoa(i+1)

		// Valor aleatório entre 0 e 20000
		amountVal := rand.Float64() * 20000
		amount := *big.NewFloat(amountVal) // Convert float64 to big.Float

		// Conta e Categoria aleatórias
		accountID := int64(accounts[rand.Intn(len(accounts))])
		categoryID := int64(categories[rand.Intn(len(categories))])

		// Data aleatória no intervalo especificado
		randomSecondsInRange := rand.Int63n(dateRangeSeconds)
		randomDate := time.Unix(startDate.Unix()+randomSecondsInRange, 0)

		// Hora aleatória
		hour := rand.Intn(24)
		minute := rand.Intn(60)
		timeStr := fmt.Sprintf("%02d:%02d", hour, minute)

		done := true
		if randomDate.After(today) {
			done = false
		}

		var releaseType models.ReleaseType
		if i%2 == 0 {
			releaseType = models.ReleaseTypeE
		} else {
			releaseType = models.ReleaseTypeR
		}

		release := models.Release{
			UserID:              int64(s.UserID),
			Description:         &description,
			AccountID:           &accountID,
			Amount:              amount,
			Type:                releaseType, // Varied release type
			Done:                done,
			CategoryID:          &categoryID,
			Date:                randomDate,
			Time:                &timeStr,
			IsBalanceAdjustment: false,
			// Outros campos podem ser definidos com valores padrão ou aleatórios se necessário
		}
		releasesToInsert = append(releasesToInsert, release)

		if (i+1)%10000 == 0 {
			fmt.Printf("%d lançamentos gerados\n", i+1)
		}
	}

	fmt.Println("Iniciando inserção de lançamentos no banco de dados")
	err := s.Repository.BatchInsertReleases(releasesToInsert)
	if err != nil {
		panic(fmt.Sprintf("Erro ao inserir lançamentos em lote: %v", err))
	}

	fmt.Printf("%d lançamentos inseridos com sucesso!\n", s.TotalInserts)
}

func (s *Service) getAccounts(userID int) {
	accountsIds, err := s.Repository.GetAccountsId(userID)
	if err != nil {
		panic(err)
	}

	accounts = accountsIds
}

func (s *Service) getCategories(userID int) {
	categoriesIds, err := s.Repository.GetCategoriesId(userID)
	if err != nil {
		panic(err)
	}

	categories = categoriesIds
}
