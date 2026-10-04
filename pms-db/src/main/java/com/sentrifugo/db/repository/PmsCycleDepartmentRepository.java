package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCycleDepartmentEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsCycleDepartmentRepository extends JpaRepository<PmsCycleDepartmentEntity, UUID> {
}
