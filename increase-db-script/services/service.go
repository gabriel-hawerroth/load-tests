package services

import (
	"fmt"

	"github.com/gabriel-hawerroth/increase-db-script/repositories"
)

type Service struct {
	Repository repositories.Repository
}

func NewService(Repository repositories.Repository) *Service {
	return &Service{
		Repository: Repository,
	}
}

var (
	accounts []int
)

func (s *Service) Process() {
	s.getAccounts()

	for _, account := range accounts {
		fmt.Printf("%d - ", account)
	}
}

func (s *Service) getAccounts() {
	accountsIds, err := s.Repository.GetAccountsId()
	if err != nil {
		panic(err)
	}

	accounts = accountsIds
}
