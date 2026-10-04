package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCyclePlantEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsCyclePlantRepository extends JpaRepository<PmsCyclePlantEntity, UUID> {
}
